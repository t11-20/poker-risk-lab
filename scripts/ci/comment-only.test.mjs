/**
 * A wrong "comment-only" answer skips the runtime gates for a real change, so every file kind it reads
 * is pinned both ways here: a comment edit passes, and the smallest real edit beside it does not.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { firstCodeChange } from './comment-only.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A repository holding `files`, then a second commit applying `change`; returns its first verdict. */
function verdict(files, change) {
  const dir = mkdtempSync(join(tmpdir(), 'prl-comment-only-'));
  scratch.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ci@example.invalid');
  git(dir, 'config', 'user.name', 'ci');
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  for (const [path, text] of Object.entries(files)) write(path, text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  change(write, dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'change');
  return firstCodeChange({ checkout: dir, base, swcFrom: REPO });
}

const TS =
  '// why\nexport const pot = 120;\n/** Units. */\nexport function call(n: number) {\n  return n * 2;\n}\n';
const TSX = 'export function A() {\n  return <p>{/* note */}hello</p>;\n}\n';

describe('comment-only, file by file', () => {
  it('TypeScript: a comment edit passes, a changed value does not', async () => {
    assert.equal(await verdict({ 'a.ts': TS }, (w) => w('a.ts', TS.replace('// why', '// a reason'))), null);
    assert.match(
      await verdict({ 'a.ts': TS }, (w) => w('a.ts', TS.replace('120', '121'))),
      /a\.ts: more than comments/,
    );
  });

  it('JSX: dropping a comment container passes, changing text does not', async () => {
    assert.equal(await verdict({ 'a.tsx': TSX }, (w) => w('a.tsx', TSX.replace('{/* note */}', ''))), null);
    assert.match(
      await verdict({ 'a.tsx': TSX }, (w) => w('a.tsx', TSX.replace('hello', 'hullo'))),
      /more than comments/,
    );
  });

  it('CSS, YAML, a Dockerfile and seed SQL: comments pass, rules and values do not', async () => {
    const files = {
      's.css': '/* why */\n.a { color: red; }\n',
      'w.yml': '# why\njobs:\n  a:\n    timeout-minutes: 5\n',
      Dockerfile: '# why\nFROM node:24\nRUN true\n',
      'db/seeds/s.sql': '-- why\nselect 1;\n',
    };
    assert.equal(
      await verdict(files, (w) => {
        w('s.css', '/* a reason */\n.a { color: red; }\n');
        w('w.yml', '# a reason\njobs:\n  a:\n    timeout-minutes: 5 # trailing\n');
        w('Dockerfile', '# a reason\nFROM node:24\nRUN true\n');
        w('db/seeds/s.sql', '-- a reason\nselect 1;\n');
      }),
      null,
    );
    assert.match(await verdict(files, (w) => w('s.css', '.a { color: blue; }\n')), /s\.css/);
    assert.match(
      await verdict(files, (w) => w('w.yml', '# why\njobs:\n  a:\n    timeout-minutes: 6\n')),
      /w\.yml/,
    );
    assert.match(
      await verdict(files, (w) => w('Dockerfile', '# why\nFROM node:24\nRUN false\n')),
      /Dockerfile/,
    );
    assert.match(await verdict(files, (w) => w('db/seeds/s.sql', '-- why\nselect 2;\n')), /s\.sql/);
  });

  it('runs everything when it cannot prove the change is only comments', async () => {
    assert.match(
      await verdict({ 'db/migrations/0001_x.sql': '-- a\nselect 1;\n' }, (w) =>
        w('db/migrations/0001_x.sql', '-- b\nselect 1;\n'),
      ),
      /checksummed/,
    );
    assert.match(await verdict({ 'a.ts': TS }, (w) => w('b.ts', TS)), /b\.ts: status A/);
    assert.match(
      await verdict({ 'c.json': '{}\n' }, (w) => w('c.json', '{ }\n')),
      /not a file this check can read/,
    );
    assert.equal(await verdict({ 'a.ts': TS }, () => undefined), 'no changed files');
  });

  it('lets Markdown through, because no runtime gate reads it', async () => {
    assert.equal(await verdict({ 'a.md': '# x\n', 'a.ts': TS }, (w) => w('a.md', '# y\n')), null);
  });
});
