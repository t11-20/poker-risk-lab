/**
 * The `changes` job in ci.yml decides whether nine jobs run. These tests run its own shell, read out
 * of the workflow, against scratch repositories, so a docs-only verdict on a code change fails here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');

// Comments can still change what these see (`@ts-expect-error`, a bundler magic comment).
const CODE_GATED = ['typecheck', 'exhaustive', 'build', 'containers'];
// The runtime gates: identical ASTs run identically, so a comment-only change or a draft skips them.
const HEAVY = ['end-to-end', 'simulation', 'a11y', 'ax-tree', 'browser-gates'];
const ALWAYS = ['supply-chain', 'lint', 'test'];
const CONDITION = "    if: needs.changes.outputs.code == 'true'";
const HEAVY_CONDITION = "    if: needs.changes.outputs.heavy == 'true'";

function jobBodies(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  const bodies = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([a-z0-9-]+):$/u.exec(line);
    if (header) {
      current = header[1];
      bodies.set(current, []);
    } else if (current !== null) bodies.get(current).push(line);
  }
  return bodies;
}

function classifierScript(text, step = 'Classify') {
  const body = jobBodies(text).get('changes');
  assert.ok(body !== undefined, 'ci.yml has no `changes` job');
  const named = body.findIndex((line) => line.trim() === `- name: ${step}`);
  assert.ok(named !== -1, `the \`changes\` job has no "${step}" step`);
  const runAt = body.findIndex((line, index) => index > named && line.trim() === 'run: |');
  assert.ok(runAt !== -1, 'the `changes` job has no `run: |` step');
  const script = [];
  for (const line of body.slice(runAt + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break;
    script.push(line.slice(10));
  }
  assert.ok(
    script.some((line) => line.includes('GITHUB_OUTPUT')),
    'the classifier script was not found whole',
  );
  return script.join('\n');
}

const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A repository with one code file and one doc, then `change` applied as a second commit. */
function repoWith(change) {
  const dir = mkdtempSync(join(tmpdir(), 'prl-classify-'));
  scratch.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ci@example.invalid');
  git(dir, 'config', 'user.name', 'ci');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n'.repeat(20));
  writeFileSync(join(dir, 'README.md'), '# Title\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  change(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'change');
  return { dir, base };
}

function classify(script, dir, env) {
  const output = join(dir, '.github-output');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-e', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  const line = readFileSync(output, 'utf8').trim();
  assert.match(line, /^code=(true|false)$/u, `the classifier wrote "${line}"`);
  return line === 'code=true';
}

const SCRIPT = classifierScript(WORKFLOW);
const asPullRequest = (dir) => classify(SCRIPT, dir, { EVENT: 'pull_request', BEFORE: '' });
const asPush = (dir, before) => classify(SCRIPT, dir, { EVENT: 'push', BEFORE: before });

describe('the CI change classifier', () => {
  it('skips only when every changed path is Markdown', () => {
    const docs = repoWith((dir) => writeFileSync(join(dir, 'README.md'), '# Title\n\nMore.\n'));
    assert.equal(asPullRequest(docs.dir), false, 'a README edit alone is docs-only');
    const mixed = repoWith((dir) => {
      writeFileSync(join(dir, 'README.md'), '# Title\n\nMore.\n');
      writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    });
    assert.equal(asPullRequest(mixed.dir), true, 'a doc plus a code file is code');
  });

  it('counts a deleted code file as code', () => {
    const deleted = repoWith((dir) => rmSync(join(dir, 'a.ts')));
    assert.equal(asPullRequest(deleted.dir), true);
  });

  it('counts a code file renamed to .md as code (REGRESSION: rename detection hid the source)', () => {
    const renamed = repoWith((dir) => git(dir, 'mv', 'a.ts', 'a.ts.md'));
    assert.equal(asPullRequest(renamed.dir), true);
  });

  it('runs everything when it cannot tell: an empty diff, a zero or unknown base', () => {
    const empty = repoWith(() => undefined);
    assert.equal(asPullRequest(empty.dir), true, 'an empty diff is not evidence of docs-only');
    assert.equal(asPush(empty.dir, '0'.repeat(40)), true, 'a new branch has no previous commit');
    assert.equal(asPush(empty.dir, 'f'.repeat(40)), true, 'a base this clone does not have');
  });

  it('reads a push to main from its previous head', () => {
    const docs = repoWith((dir) => writeFileSync(join(dir, 'README.md'), '# Retitled\n'));
    assert.equal(asPush(docs.dir, docs.base), false);
  });
});

describe('which jobs the classifier can skip', () => {
  const bodies = jobBodies(WORKFLOW);
  it('gates exactly the jobs that cannot read a doc, and never the ones that do', () => {
    for (const job of HEAVY) {
      assert.ok(bodies.get(job)?.includes(HEAVY_CONDITION), `${job} should skip on a comment-only change`);
      assert.ok(
        bodies.get(job)?.some((line) => /^ {4}needs: \[.*\bchanges\b.*\]$/u.test(line)),
        `${job} must need \`changes\` to read its output`,
      );
    }
    const heavy = [...bodies].filter(([, lines]) => lines.includes(HEAVY_CONDITION)).map(([id]) => id);
    assert.deepEqual(heavy.sort(), [...HEAVY].sort(), 'a job gained or lost the runtime-gate condition');
    for (const job of CODE_GATED) {
      assert.ok(bodies.get(job)?.includes(CONDITION), `${job} should skip on a docs-only change`);
      assert.ok(
        bodies.get(job)?.some((line) => /^ {4}needs: \[.*\bchanges\b.*\]$/u.test(line)),
        `${job} must need \`changes\` to read its output`,
      );
    }
    for (const job of ALWAYS) {
      assert.ok(bodies.has(job), `${job} is missing from ci.yml`);
      assert.ok(!bodies.get(job)?.includes(CONDITION), `${job} reads docs and must always run`);
      assert.ok(!bodies.get(job)?.includes(HEAVY_CONDITION), `${job} must run on a comment-only change`);
    }
    const gated = [...bodies].filter(([, lines]) => lines.includes(CONDITION)).map(([id]) => id);
    assert.deepEqual(gated.sort(), [...CODE_GATED].sort(), 'a job gained or lost the skip condition');
  });
});

const HEAVY_SCRIPT = classifierScript(WORKFLOW, 'Decide whether the runtime gates run');
const CHECKER = readFileSync(join(REPO, 'scripts', 'ci', 'comment-only.mjs'), 'utf8');

function heavy(dir, env) {
  const output = join(dir, '.github-output');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-e', '-c', HEAVY_SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output, EVENT: 'pull_request', BEFORE: '', ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  const line = readFileSync(output, 'utf8').trim();
  assert.match(line, /^heavy=(true|false)$/u, `the decision wrote "${line}"`);
  return line === 'heavy=true';
}

/** A repository carrying the real checker, a stylesheet and a code file, then `change`. */
function repoWithChecker(change) {
  return repoWith((dir) => {
    mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'ci', 'comment-only.mjs'), CHECKER);
    change(dir);
  });
}

describe('whether the runtime gates run', () => {
  it('skips them for docs-only and for a draft, whatever the change', () => {
    const code = repoWith((dir) => writeFileSync(join(dir, 'a.ts'), 'export const a = 3;\n'));
    assert.equal(heavy(code.dir, { CODE: 'false', DRAFT: 'false' }), false, 'docs-only');
    assert.equal(heavy(code.dir, { CODE: 'true', DRAFT: 'true' }), false, 'a draft cannot merge');
  });

  it('skips them for a comment-only change and runs them for a real one', () => {
    const comment = repoWithChecker((dir) =>
      writeFileSync(join(dir, 's.css'), '/* why */\n.a { color: red; }\n'),
    );
    writeFileSync(join(comment.dir, 's.css'), '/* the reason */\n.a { color: red; }\n');
    git(comment.dir, 'add', '-A');
    git(comment.dir, 'commit', '-q', '-m', 'comment');
    assert.equal(heavy(comment.dir, { CODE: 'true', DRAFT: 'false' }), false, 'only a CSS comment changed');
    writeFileSync(join(comment.dir, 's.css'), '/* the reason */\n.a { color: blue; }\n');
    git(comment.dir, 'add', '-A');
    git(comment.dir, 'commit', '-q', '-m', 'rule');
    assert.equal(heavy(comment.dir, { CODE: 'true', DRAFT: 'false' }), true, 'a changed CSS rule');
    const code = repoWith((dir) => writeFileSync(join(dir, 'a.ts'), 'export const a = 4;\n'));
    assert.equal(heavy(code.dir, { CODE: 'true', DRAFT: 'false' }), true, 'a changed value');
  });

  it('runs them when the checker cannot run at all (REGRESSION guard: a crash is not "comment-only")', () => {
    const missing = repoWith((dir) => writeFileSync(join(dir, 'README.md'), '# Title, again\n'));
    assert.equal(heavy(missing.dir, { CODE: 'true', DRAFT: 'false' }), true, 'no checker in the tree');
  });
});
