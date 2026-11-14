/**
 * Source scans for four release-blocking rules. 1. No `Math.random`; cards and tokens come from a CSPRNG.
 * 2. No request path reaches `createDeterministicRandomForTests`, in `src/` or the packages it calls.
 * It throws under production, so a call one package away stops every sampled equity estimate.
 * 3. No `.unsafe(`; driver parameterisation is the whole SQL-injection defence. 4. No SQL names a deck
 * or salt column, so a database read cannot expose undealt or unshown cards. Each detector has a
 * negative control below, and each scan asserts it read a non-empty set.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(API_DIR, 'src');
const REPO_ROOT = join(API_DIR, '..', '..');

/** The packages a live hand and a live analysis pass through, scanned for rule 2 alongside `src/`. */
const PACKAGE_SRC_DIRS = [
  join(REPO_ROOT, 'packages', 'poker-engine', 'src'),
  join(REPO_ROOT, 'packages', 'poker-math', 'src'),
  join(REPO_ROOT, 'packages', 'poker-ai', 'src'),
];

/**
 * Files that may name the test-only generator. `rng.ts` declares it and holds the production refusal.
 * `simulate.ts` is the offline harness, and a test below asserts no API source calls its exports.
 */
const DETERMINISTIC_GENERATOR_EXEMPTIONS: readonly string[] = [
  join('packages', 'poker-engine', 'src', 'rng.ts'),
  join('packages', 'poker-ai', 'src', 'simulate.ts'),
];

/**
 * Removes re-export statements. A barrel re-export names the generator without calling it. Stripping
 * the statement, not exempting the barrel by path, means a call later added to a barrel is still caught.
 */
function stripReExports(code: string): string {
  return code.replace(/export\s*(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"][^'"]+['"]\s*;?/g, '');
}

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
 * Removes comments, so a prose mention of a banned API is not read as a use of it. Not a parser, so
 * comment markers inside a string confuse it. The `[^:]` stops it eating a line after `https://`.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Template literal bodies, as the odd chunks between backticks. A nested template would add chunks
 * rather than skip one, so the guard gets noisier, not blinder.
 */
function templateLiterals(code: string): string[] {
  const chunks = code.split('`');
  return chunks.filter((_chunk, index) => index % 2 === 1);
}

const SQL_STATEMENT = /\b(?:select|insert\s+into|update|delete\s+from)\b/i;

function sqlLiterals(code: string): string[] {
  return templateLiterals(code).filter((chunk) => SQL_STATEMENT.test(chunk));
}

/** Word-bounded, so `revealed` and the legitimate `reveal` column (salts of public cards) do not match. */
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

  it('never imports the deterministic test generator, in the API or in the packages it calls', () => {
    const scanned = [...files, ...PACKAGE_SRC_DIRS.flatMap((dir) => sourceFiles(dir))];
    // A mistyped package path would silently make this an API-only scan again.
    assert.ok(
      scanned.length > files.length + 20,
      `expected the package sources to be scanned too, found only ${scanned.length} files`,
    );

    const offences: Offence[] = [];
    for (const file of scanned) {
      const path = relative(REPO_ROOT, file);
      if (DETERMINISTIC_GENERATOR_EXEMPTIONS.includes(path)) continue;
      const code = stripReExports(stripComments(readFileSync(file, 'utf8')));
      if (code.includes('createDeterministicRandomForTests')) {
        offences.push({ file: path, detail: 'reaches the deterministic generator' });
      }
    }
    assert.deepEqual(
      offences,
      [],
      'no request path may reach a test-only generator — it throws under NODE_ENV=production, ' +
        `and \`createSamplingRandom\` is the production-legal source for estimation:\n${describeOffences(offences)}`,
    );
  });

  it('keeps the simulate.ts exemption honest: no API source calls its exports', () => {
    const simulate = readFileSync(join(REPO_ROOT, 'packages', 'poker-ai', 'src', 'simulate.ts'), 'utf8');
    const exported = [...simulate.matchAll(/^export (?:function|const|class) ([A-Za-z][A-Za-z0-9_]*)/gm)].map(
      (match) => match[1] ?? '',
    );
    assert.ok(exported.length > 3, `expected to find simulate.ts exports, found ${exported.length}`);

    const offences: Offence[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const name of exported) {
        if (new RegExp(`\\b${name}\\b`).test(code)) {
          offences.push({ file: relative(API_DIR, file), detail: `calls simulate.ts export ${name}` });
        }
      }
    }
    assert.deepEqual(
      offences,
      [],
      `simulate.ts is exempt from the generator rule only because no request path reaches it:\n${describeOffences(offences)}`,
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
    assert.ok(stripComments('const u = "https://x.test"; const y = Math.random();').includes('Math.random'));
  });

  it('drops a re-export of the generator but still catches a call to it', () => {
    const barrel = "export { createDeterministicRandomForTests, createSecureRandom } from './rng.ts';";
    assert.ok(
      !stripReExports(barrel).includes('createDeterministicRandomForTests'),
      'a plain re-export names the symbol without reaching it, and must not be an offence',
    );
    assert.ok(!stripReExports("export * from './rng.ts';").includes('rng.ts'));
    const smuggled =
      "export { createSecureRandom } from './rng.ts';\nconst r = createDeterministicRandomForTests(1);";
    assert.ok(
      stripReExports(smuggled).includes('createDeterministicRandomForTests'),
      'a call in a barrel must still be caught',
    );
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
    // No interpolation in the samples: the splitter never looks inside `${}`, and one here would trip
    // `noTemplateCurlyInString`.
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
