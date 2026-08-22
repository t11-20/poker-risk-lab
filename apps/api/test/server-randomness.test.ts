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
 *   2. `createDeterministicRandomForTests` is never imported by anything a request can reach —
 *      neither `apps/api/src` nor the pure-core packages it calls into. It exists for tests and
 *      for reproducible teaching hands; a hand dealt from it is permanently labelled
 *      `deterministic-test-only`, and no request path may reach it.
 *
 *      This rule used to scan `apps/api/src` alone, and that gap cost a production outage:
 *      `monteCarloEquity` in `packages/poker-math` called the test-only generator, which throws
 *      when `NODE_ENV === 'production'`, so every sampled equity estimate failed on a real server
 *      — the Coach could not answer and a bot needing a sampled estimate never acted, so the
 *      table simply stopped. The scan passed the whole time because the call was one package
 *      away. It now follows the request path into the packages; see `PACKAGE_SRC_DIRS` and the
 *      two exemptions below, and `packages/poker-math/test/production-sampling.test.ts` for the
 *      behavioural half of the same fix.
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
const REPO_ROOT = join(API_DIR, '..', '..');

/**
 * The pure-core packages a request actually reaches, scanned for rule 2 alongside `src/`.
 *
 * Not every package: `content` and `ui` hold no randomness, and scanning them would only make
 * the exemption list below look shorter than the risk it manages. These three are the ones a
 * live hand and a live analysis pass through.
 */
const PACKAGE_SRC_DIRS = [
  join(REPO_ROOT, 'packages', 'poker-engine', 'src'),
  join(REPO_ROOT, 'packages', 'poker-math', 'src'),
  join(REPO_ROOT, 'packages', 'poker-ai', 'src'),
];

/**
 * The two files that may name the test-only generator, and why each one is not a request path.
 *
 * An allowlist is a liability, so it is deliberately tiny and each entry carries the reason it
 * cannot become a live call — a reason a reader can check, not a promise.
 *
 *   rng.ts       declares the function. It cannot avoid naming it, and it is the file that
 *                carries the `NODE_ENV === 'production'` refusal.
 *   simulate.ts  the offline profile harness behind `pnpm run test:simulation` and the fixture
 *                generator. Nothing in `apps/api/src` calls its exports, which is asserted
 *                below rather than assumed — that assertion is what keeps this exemption honest.
 */
const DETERMINISTIC_GENERATOR_EXEMPTIONS: readonly string[] = [
  join('packages', 'poker-engine', 'src', 'rng.ts'),
  join('packages', 'poker-ai', 'src', 'simulate.ts'),
];

/**
 * Removes `export ... from '...'` re-export statements.
 *
 * A barrel that re-exports a banned symbol NAMES it without being able to CALL it, and
 * `packages/poker-engine/src/index.ts` legitimately does exactly that so tests can import the
 * generator from the package root. Exempting the whole barrel by path would have worked and
 * would have been worse: an exemption is a promise that a file stays harmless, and a barrel is
 * a file somebody eventually puts a line of logic into.
 *
 * Stripping the re-export instead keeps the rule pointed at what matters — an actual reference
 * in executable position — and generalises to every barrel added later without another entry in
 * the list above. A `call` inside a barrel is still caught, which the companion detector test
 * asserts rather than assumes.
 */
function stripReExports(code: string): string {
  return code.replace(/export\s*(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"][^'"]+['"]\s*;?/g, '');
}

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

  it('never imports the deterministic test generator, in the API or in the packages it calls', () => {
    const scanned = [...files, ...PACKAGE_SRC_DIRS.flatMap((dir) => sourceFiles(dir))];
    // The scan is only meaningful if it reached the packages at all; a mistyped path would
    // otherwise make this the same API-only check it used to be, silently.
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
    // The exemption above rests entirely on `simulate.ts` being offline-only. If an API module
    // ever imports one of its exports, the exemption stops being true and this fails — which is
    // the whole point of writing the reason down as an assertion rather than as a comment.
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
    // The guard that stops the line-comment rule eating a URL, and with it the rest of the line.
    assert.ok(stripComments('const u = "https://x.test"; const y = Math.random();').includes('Math.random'));
  });

  it('drops a re-export of the generator but still catches a call to it', () => {
    const barrel = "export { createDeterministicRandomForTests, createSecureRandom } from './rng.ts';";
    assert.ok(
      !stripReExports(barrel).includes('createDeterministicRandomForTests'),
      'a plain re-export names the symbol without reaching it, and must not be an offence',
    );
    assert.ok(!stripReExports("export * from './rng.ts';").includes('rng.ts'));
    // The half that matters: stripping re-exports must not become a way to hide a real call.
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
