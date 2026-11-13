#!/usr/bin/env node
/**
 * Tests for the release-gate coverage guard. Each control breaks one thing in a real workflow,
 * because a parser that finds no jobs would report every gate covered by the empty set.
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
    // Spot-checked so a truncated list cannot pass.
    for (const gate of ['security:audit', 'design:contrast', 'test:ax', 'db:verify']) {
      assert.ok(gates.includes(gate), `\`verify\` runs ${gate} and the parser did not see it`);
    }
    assert.equal(new Set(gates).size, gates.length, 'a gate is listed twice');
  });

  it('NEGATIVE CONTROL — refuses a verify script it cannot read, rather than reporting none', () => {
    // An empty gate list is trivially all covered.
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
    // Both `needs` spellings are in use, a scalar on `tests` and a flow sequence on `build`.
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
    // Comments in the workflows name gates in prose and must not count as coverage.
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
    // release.yml runs `pnpm run test`, so a prefix match would report every `test:*` gate covered.
    assert.equal(runsGate('run: pnpm run test', 'test'), true);
    for (const gate of ['test:a11y', 'test:ax', 'test:csp', 'test:exhaustive']) {
      assert.equal(runsGate('run: pnpm run test', gate), false, `\`pnpm run test\` matched ${gate}`);
    }
    assert.equal(runsGate('run: pnpm run test:a11y -- --with-api', 'test:a11y'), true);
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

// The README Quick start gate count said 11 while the audit ran 15. This guards that one line only.
describe('the README does not promise a gate count the audit does not run', () => {
  const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');

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

    assert.equal(/pnpm run security:audit\s+#\s*(\d+)\s+supply-chain gates/u.exec('# audit'), null);
  });
});

// The README Stack line had all four versions wrong on 2026-11-11. It is joined here to the exact
// pins in the package.json files.
describe('the README Stack line names the versions that are pinned', () => {
  const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const pinned = (workspace, name) => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, workspace, 'package.json'), 'utf8'));
    return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
  };
  const STACK = [
    ['Next.js', pinned('apps/web', 'next')],
    ['React', pinned('apps/web', 'react')],
    ['Fastify', pinned('apps/api', 'fastify')],
    ['Biome', pinned('.', '@biomejs/biome')],
    ['TypeScript', pinned('.', 'typescript')],
  ];

  const stackSection = (text) => /^## Stack\n([\s\S]*?)\n---/mu.exec(text)?.[1] ?? null;
  const stated = (section) =>
    STACK.map(([product]) => [
      product,
      new RegExp(`${product} (\\d+\\.\\d+\\.\\d+)`, 'u').exec(section)?.[1],
    ]);

  it('states each pinned version exactly (REGRESSION)', () => {
    const section = stackSection(README);
    assert.ok(
      section !== null,
      'README.md has no "## Stack" section ending at a rule; this guard reads nothing',
    );
    for (const [product, version] of STACK) {
      assert.match(
        String(version),
        /^\d+\.\d+\.\d+$/u,
        `${product} is not pinned exact; the join is to nothing`,
      );
    }
    for (const [index, [product, written]] of stated(section).entries()) {
      assert.equal(
        written,
        STACK[index][1],
        `README.md Stack says ${product} ${written}; pinned is ${STACK[index][1]}`,
      );
    }
  });

  it('NEGATIVE CONTROL — the README as it stood on 2026-11-11 is caught', () => {
    const stale = stackSection(README)?.replace(/Next\.js \d+\.\d+\.\d+/u, 'Next.js 16.3.8');
    assert.ok(stale?.includes('Next.js 16.3.8') === true, 'the control did not make the line stale');
    const written = Object.fromEntries(stated(stale));
    assert.notEqual(written['Next.js'], pinned('apps/web', 'next'));
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
    // A gate in a job beside `build` would go red while the artefact was still built and offered for signing.
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
    const gates = [...gatesInVerify(PKG), 'test:collision'];
    const result = coverage(parseWorkflow(RELEASE), gates);
    assert.deepEqual(result.missing, ['test:collision']);
  });

  it('ci.yml runs every verify gate somewhere (REGRESSION)', () => {
    // Weaker than the release claim, because ci.yml has no single sink job.
    const gates = gatesInVerify(PKG);
    const jobs = parseWorkflow(CI);
    assertParserSawTheFile(jobs, 'ci.yml');
    const text = [...jobs.values()].map((job) => job.body.join('\n')).join('\n');
    const missing = gates.filter((gate) => !runsGate(text, gate));
    assert.deepEqual(missing, [], `no job in ci.yml runs: ${missing.join(', ')}`);
  });
});
