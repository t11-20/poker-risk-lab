/**
 * Guard test: four rules about server source that no reviewer should have to remember.
 *
 * These are source scans, which is a blunt instrument. They are here anyway because the mistakes
 * they catch are the ones introduced later, in a hurry, by somebody reaching for the convenient
 * thing — `Math.random()` because it is shorter, `.unsafe()` because a fragment would not
 * interpolate, a `deck` column because persisting the hand would make restarts easier. None of
 * those looks wrong in a diff. All four are release-blocking.
 *
 * The rules:
 *
 *   1. `Math.random` never appears in code. Cards, tokens and invite codes come from a CSPRNG.
 *   2. `createDeterministicRandomForTests` is never imported by server source. It exists for tests
 *      and for reproducible teaching hands; a hand dealt from it is permanently labelled
 *      `deterministic-test-only`, and no request path may reach it.
 *   3. `.unsafe(` never appears. The `postgres` driver parameterises by construction, and that
 *      property is the whole SQL-injection defence here. The one legitimate caller — the migration
 *      runner — lives in `apps/api/scripts/`, outside the tree this scans.
 *   4. No SQL names a deck or salt column. There is no such column and there must never be one:
 *      `db/migrations/0001_initial.sql` says so in capitals, because a database read must not be
 *      able to expose the undealt cards of a live hand or the unshown holdings of a finished one.
 *
 * ## Every detector is proved to fail
 *
 * Copied from `packages/poker-engine/test/rng.test.ts`, which makes the same point: a guard test
 * that cannot fail is decoration. Each scan below has a companion test that feeds it a violation
 * and asserts it fires, and feeds it a prose mention and asserts it does not. The scans also
 * assert they found something to scan — a walker that silently matched zero files would pass for
 * ever, which is the most likely way any of this quietly stops working.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(API_DIR, 'src');

/** Every `.ts` file under `src/`, recursively. */
function sourceFiles(dir: string = SRC_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

/**
 * Removes block and line comments, so a prose mention of a banned API is not read as a use of it.
 *
 * Taken from `packages/poker-engine/test/rng.test.ts` unchanged, including its limitation: it is
 * not a parser, so a `//` or a `/*` inside a string literal would confuse it. The `[^:]` before
 * the line-comment match is what stops it eating the rest of a line after `https://`. Every one of
 * these rules is documented in prose in the very files it applies to, so matching the raw text
 * would produce a false positive on the comment explaining the rule.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The contents of every template literal in the given code.
 *
 * Splitting on backticks: odd-numbered chunks are literal bodies. That is exact for this codebase
 * because no template literal here nests another one inside a `${}` expression — and if one ever
 * does, the failure mode is extra chunks to scan rather than a chunk skipped, so the guard gets
 * noisier rather than blinder.
 */
function templateLiterals(code: string): string[] {
  const chunks = code.split('`');
  return chunks.filter((_chunk, index) => index % 2 === 1);
}

const SQL_STATEMENT = /\b(?:select|insert\s+into|update|delete\s+from)\b/i;

/** Template literals that read as SQL. Everything else is a message, a key or an id. */
function sqlLiterals(code: string): string[] {
  return templateLiterals(code).filter((chunk) => SQL_STATEMENT.test(chunk));
}

/**
 * A column reference this schema does not have and must never have.
 *
 * Word-bounded so that `revealed`, `desalted` or a table alias like `s.` cannot match, and so the
 * legitimate `reveal` column — which does carry per-position salts for cards that are already
 * public — is not mistaken for one.
 */
const FORBIDDEN_COLUMN = /\b(?:deck|deck_order|deck_cursor|deck_salts|salt|salts|commitment_salt)\b/i;

interface Offence {
  readonly file: string;
  readonly detail: string;
}

function describeOffences(offences: readonly Offence[]): string {
  return offences.map((offence) => `${offence.file}: ${offence.detail}`).join('\n');
}

describe('server source obeys the randomness and SQL rules', () => {
  const files = sourceFiles();

  it('scans a non-empty tree, so a passing result means something', () => {
    assert.ok(files.length > 5, `expected to find server source under src/, found ${files.length} files`);
    const totalSql = files.reduce(
      (count, file) => count + sqlLiterals(stripComments(readFileSync(file, 'utf8'))).length,
      0,
    );
    assert.ok(totalSql > 0, 'found no SQL at all in src/, so the SQL rules below proved nothing');
  });

  it('never uses Math.random', () => {
    const offences: Offence[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (code.includes('Math.random')) {
        offences.push({ file: relative(API_DIR, file), detail: 'uses Math.random' });
      }
    }
    assert.deepEqual(
      offences,
      [],
      `cards, tokens and invite codes must come from a CSPRNG:\n${describeOffences(offences)}`,
    );
  });

  it('never imports the deterministic test generator', () => {
    const offences: Offence[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (code.includes('createDeterministicRandomForTests')) {
        offences.push({ file: relative(API_DIR, file), detail: 'reaches the deterministic generator' });
      }
    }
    assert.deepEqual(
      offences,
      [],
      `no request path may deal from a seeded generator:\n${describeOffences(offences)}`,
    );
  });

  it('never calls .unsafe()', () => {
    const offences: Offence[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (code.includes('.unsafe(')) {
        offences.push({ file: relative(API_DIR, file), detail: 'calls .unsafe()' });
      }
    }
    assert.deepEqual(
      offences,
      [],
      `one .unsafe() with a value spliced in defeats the whole defence:\n${describeOffences(offences)}`,
    );
  });

  it('has no SQL naming a deck or salt column', () => {
    const offences: Offence[] = [];
    for (const file of files) {
      for (const statement of sqlLiterals(stripComments(readFileSync(file, 'utf8')))) {
        const match = FORBIDDEN_COLUMN.exec(statement);
        if (match !== null) {
          offences.push({ file: relative(API_DIR, file), detail: `SQL mentions "${match[0]}"` });
        }
      }
    }
    assert.deepEqual(
      offences,
      [],
      `the deck and the commitment salts have no column and must never get one:\n${describeOffences(offences)}`,
    );
  });
});

describe('the detectors can actually fail', () => {
  it('strips comments without hiding real code', () => {
    assert.ok(stripComments('const x = Math.random();').includes('Math.random'));
    assert.ok(!stripComments('// mentions Math.random in prose').includes('Math.random'));
    assert.ok(!stripComments('/* mentions Math.random in a block */').includes('Math.random'));
    // The guard that stops the line-comment rule eating a URL, and with it the rest of the line.
    assert.ok(stripComments('const u = "https://x.test"; const y = Math.random();').includes('Math.random'));
  });

  it('catches the deterministic generator and .unsafe() in code but not in prose', () => {
    assert.ok(
      stripComments('import { createDeterministicRandomForTests } from "x";').includes('createDeter'),
    );
    assert.ok(!stripComments('// never import createDeterministicRandomForTests').includes('createDeter'));
    assert.ok(stripComments('await sql.unsafe(text);').includes('.unsafe('));
    assert.ok(!stripComments('/* never call .unsafe( */').includes('.unsafe('));
  });

  it('finds SQL inside template literals and ignores literals that are not SQL', () => {
    // The samples carry no interpolation, which is not a gap: `templateLiterals` splits on
    // backticks and never looks inside a `${}`, so an interpolated value is just more text to it.
    // Writing one here would trip `noTemplateCurlyInString` in this file for no gain.
    const code = 'const a = sql`select id from prl.hands where id = 1`; const b = `seat three`;';
    assert.deepEqual(sqlLiterals(code), ['select id from prl.hands where id = 1']);
    assert.deepEqual(sqlLiterals('const b = `seat three`;'), []);
  });

  it('flags a deck or salt column and leaves the legitimate reveal column alone', () => {
    const bad = 'insert into prl.hands (deck, deck_salts) values (1, 2)';
    assert.match(bad, FORBIDDEN_COLUMN);
    assert.match('select salt from x', FORBIDDEN_COLUMN);
    assert.doesNotMatch('select h.reveal, h.commitment_root from prl.hands h', FORBIDDEN_COLUMN);
    assert.doesNotMatch('select revealed_at from x', FORBIDDEN_COLUMN);
  });
});
