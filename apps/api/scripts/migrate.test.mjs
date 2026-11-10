/**
 * Tests for the parts of migrate.mjs that are policy rather than plumbing.
 *
 * The release audit found that this project had no rollback path AND no stated
 * policy in place of one — a deployment that cannot be rolled back and does not
 * say so. The answer was to make roll-forward-only explicit and enforced, and an
 * enforced policy with no test is a claim. So these tests cover exactly the two
 * mechanisms that carry it: `down` answering with the policy, and `up` refusing a
 * migration that destroys something without declaring it.
 *
 * Run:  node --test apps/api/scripts/migrate.test.mjs
 *
 * The root `test:scripts` script reaches this file: its glob covers both the top-level
 * `scripts` directory and `apps/api/scripts`. (Glob patterns are described here rather than
 * written out, because a literal one contains the sequence that ends a block comment — this
 * file previously hid that behind zero-width spaces, which `repo-hygiene.mjs` rejects.)
 *
 * No database is needed: nothing here connects, which is itself part of what is
 * being asserted about `down`.
 *
 * ## The second thing these tests carry: a failure that names the file
 *
 * `applyFile` used to let the raw driver error through, and the top-level handler
 * printed only its `message`. With four files in db/migrations that meant an
 * operator saw `relation "users" already exists` and nothing naming the file, the
 * line, or even which command had been running.
 *
 * The tests for that drive the REAL `applyFile` with a real broken `.sql` file on
 * disk and a stub connection handle whose `unsafe` rejects with the exact shape
 * postgres.js produces. What that proves: the production call path turns a driver
 * failure into a message naming the file, the line, the column, the statement and
 * the SQLSTATE. What it does NOT prove, stated plainly: that a live PostgreSQL
 * populates `position` the way the fixtures here do. That half was checked by hand
 * against a scratch database — `select 1` followed by `creat table` through
 * `sql.unsafe` returns `code 42601` with `position: '25'` as a STRING, which
 * `locateInSource` maps to line 4 column 1 — and a `migrate up` re-run against an
 * emptied ledger produced `migration 0001_initial.sql failed ... type
 * "prefixed_id" already exists ... code: 42710`. Neither run lives here, because a
 * test that needs a database has no business in a file whose whole point is that it
 * needs none.
 *
 * ## Would these fail if the behaviour broke?
 *
 * Yes, and it is checked rather than asserted: `assertNamesTheFile` is run a second
 * time against the message the OLD code produced — the bare driver `message` — and
 * required to throw. A message that stopped naming the file would fail the first
 * call for the same reason the old one fails the second.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  applyFile,
  declaresIrreversible,
  findIrreversibleStatements,
  locateInSource,
  parseArgs,
  refuseUnconfirmedReset,
  stripSqlComments,
} from './migrate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATE = join(HERE, 'migrate.mjs');
const MIGRATIONS_DIR = resolve(HERE, '..', '..', '..', 'db', 'migrations');
const run = promisify(execFile);

/** Runs migrate.mjs and returns its output, whether it exited 0 or not. */
async function migrate(args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [MIGRATE, ...args], {
      // DATABASE_URL is deliberately not inherited: a command that answers
      // without one is part of what these tests assert.
      env: { PATH: process.env['PATH'] ?? '', NO_COLOR: '1', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('`down` is a real command that states the roll-forward-only policy', async () => {
  const { code, stdout } = await migrate(['down']);

  // Exit non-zero: a deploy pipeline that asks for a rollback must not be told
  // that one happened.
  assert.equal(code, 1, 'down must fail rather than appear to succeed');

  // Before this policy existed, `down` produced `Unknown command "down"`, which
  // reads like a version skew and sends an operator looking for a missing release
  // instead of reading a decision. That specific wording must never come back.
  assert.doesNotMatch(stdout, /Unknown command/i, 'down must be a command, not an unrecognised word');

  assert.match(stdout, /roll-forward only/i);
  // The three things an operator actually needs told, rather than just a refusal.
  assert.match(stdout, /write the next migration/i);
  assert.match(stdout, /restore from backup/i);
  assert.match(stdout, /reset/i);
});

test('`down` answers without a database connection and without DATABASE_URL', async () => {
  const { stdout } = await migrate(['down']);
  // If it had tried to connect it would have complained about the missing URL
  // instead, and in production it would have authenticated against the live
  // database to be told something this script already knew.
  assert.doesNotMatch(stdout, /DATABASE_URL is not set|DATABASE_MIGRATION_URL/i);
});

test('the usage text names `down` and `roles`', async () => {
  const { code, stdout } = await migrate(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /^\s*down\s+refuses/m);
  assert.match(stdout, /^\s*roles\s+/m);
});

/**
 * Every shipped migration satisfies the gate `up` actually applies.
 *
 * ## What this used to assert, and why it was narrower than its own name
 *
 * It called `findIrreversibleStatements` alone and required the result to be empty for every file
 * — i.e. that no migration in the repository is destructive at all. That is not the gate. The gate
 * is `refuseUndeclaredIrreversible` in `migrate.mjs`, and it refuses a destructive migration
 * **that does not say so**; a file carrying `-- prl:irreversible: <reason>` is applied, because the
 * whole point of the marker is that some changes cannot be additive and the person writing one has
 * to state what is lost.
 *
 * So the old body tested half the gate under the full gate's name, and it happened to pass for as
 * long as every migration was additive. `0003_bot_seat_recovery.sql` is the first that cannot be:
 * changing a CHECK constraint's predicate requires dropping it, there is no `ALTER CONSTRAINT` for
 * that, and the constraint being replaced is the one that destroyed seven of the twelve AI Legends'
 * identities on every write.
 *
 * Rewritten to the runner's real rule, plus the part that keeps the marker from becoming a rubber
 * stamp: a file that declares itself irreversible must give a REASON, and `declaresIrreversible`
 * already requires a non-empty one. A migration that is destructive and silent still fails here,
 * which is the property worth having.
 */
test('every migration already in db/migrations satisfies the gate `up` applies', async () => {
  // The gate has to read code, not prose. 0001_initial.sql explains at length
  // that the runtime role holds no DROP and no TRUNCATE, and a naive scan of the
  // raw text flags a migration that does neither of those things.
  const names = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(names.length > 0, 'expected migrations to exist');

  const undeclared = [];
  const declared = [];
  for (const name of names) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
    const found = findIrreversibleStatements(sql);
    if (found.length === 0) continue;
    if (declaresIrreversible(sql)) declared.push(`${name}: ${found.map((f) => f.snippet).join(', ')}`);
    else undeclared.push(`${name}: ${found.map((f) => f.snippet).join(', ')}`);
  }

  assert.deepEqual(
    undeclared,
    [],
    `these migrations destroy something and do not declare it, so \`up\` would refuse them:\n  ${undeclared.join('\n  ')}`,
  );

  // Not an assertion, a record: a reviewer reading this test's output should see which migrations
  // are not additive without having to grep for the marker.
  if (declared.length > 0) console.info(`  declared irreversible: ${declared.join('; ')}`);
});

test('a declaration without a reason is not a declaration', () => {
  // The marker is only worth anything if it costs something to write. An empty one must not pass.
  assert.equal(declaresIrreversible('-- prl:irreversible:\nDROP TABLE prl.thing;'), false);
  assert.equal(declaresIrreversible('-- prl:irreversible:   \nDROP TABLE prl.thing;'), false);
  assert.equal(
    declaresIrreversible('-- prl:irreversible: the old CHECK is replaced\nALTER TABLE t DROP CONSTRAINT c;'),
    true,
  );
});

test('the gate fires on each kind of statement that cannot be rolled forward past', () => {
  const cases = [
    ['drop table', 'SET ROLE prl_migrator;\nDROP TABLE prl.quiz_attempts;'],
    ['drop schema', 'DROP SCHEMA prl CASCADE;'],
    ['drop column', 'ALTER TABLE prl.users DROP COLUMN display_name;'],
    ['drop constraint', 'ALTER TABLE prl.rooms DROP CONSTRAINT rooms_visibility_invite_only;'],
    ['truncate', 'TRUNCATE prl.audit_log;'],
    ['delete', 'DELETE FROM prl.sessions WHERE expires_at < now();'],
    ['rename table', 'ALTER TABLE prl.hands RENAME TO hands_old;'],
    ['rename column', 'ALTER TABLE prl.hands RENAME COLUMN board TO cards;'],
  ];
  for (const [label, sql] of cases) {
    const found = findIrreversibleStatements(sql);
    assert.ok(found.length > 0, `${label} should be flagged, got nothing`);
  }
});

test('the gate leaves ordinary additive DDL alone', () => {
  const additive = [
    'CREATE TABLE prl.thing (id text primary key);',
    'ALTER TABLE prl.users ADD COLUMN locale text;',
    'CREATE UNIQUE INDEX thing_key ON prl.thing (id);',
    'DROP INDEX prl.thing_key;',
    'REVOKE ALL ON SCHEMA prl FROM PUBLIC;',
    'GRANT SELECT ON prl.thing TO prl_app;',
    'ALTER TABLE prl.thing ALTER COLUMN id SET NOT NULL;',
  ];
  for (const sql of additive) {
    assert.deepEqual(findIrreversibleStatements(sql), [], `should not be flagged: ${sql}`);
  }
});

test('a DROP that is only mentioned, not executed, is not a destructive statement', () => {
  const prose = [
    '-- prl_app is never granted CREATE, DROP TABLE, TRUNCATE or REFERENCES.',
    '/* An earlier draft did DROP TABLE prl.scores; see ADR 0010 for why it does not. */',
    "SELECT 'drop table prl.users' AS never_run;",
    "DO $$ BEGIN RAISE NOTICE 'truncate is not something this role may do'; END $$;",
    "CREATE TABLE prl.note (body text default 'delete from nothing');",
  ].join('\n');
  assert.deepEqual(findIrreversibleStatements(prose), []);
});

test('a DROP hidden inside a DO block IS still a destructive statement', () => {
  // Dollar-quoted bodies are code, and are the one place a real drop could hide
  // from a scanner that treated every quoted run as data.
  const sql = 'DO $$ BEGIN\n  DROP TABLE prl.quiz_attempts;\nEND $$;';
  assert.ok(findIrreversibleStatements(sql).length > 0);
});

test('stripSqlComments removes comments without moving anything else', () => {
  const sql = "SELECT 1; -- a comment\n/* block\n   comment */ SELECT 2;\nSELECT '-- not a comment';";
  const stripped = stripSqlComments(sql);
  assert.doesNotMatch(stripped, /a comment/);
  assert.doesNotMatch(stripped, /block/);
  assert.match(stripped, /SELECT 1;/);
  assert.match(stripped, /SELECT 2;/);
  // Offsets are preserved so a reported snippet still lines up with the file.
  assert.equal(stripped.length, sql.length);
  // Nested block comments are one comment, not one and a half.
  assert.doesNotMatch(stripSqlComments('/* a /* b */ c */ SELECT 3;'), /[abc]\s/);
});

// ---------------------------------------------------------------------------
// A migration that fails says WHICH ONE.
// ---------------------------------------------------------------------------

/** Temp directories this file made, removed once whatever happened has happened. */
const scratchDirs = [];

after(async () => {
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
});

/**
 * Writes a real `.sql` file and returns it in the shape `readSqlDir` produces.
 *
 * A real file rather than a string literal, because half of what is being asserted is that the
 * message can point an operator at something they can open: the path, and a line number inside
 * it that matches what an editor will show.
 */
async function brokenMigration(name, sql) {
  const dir = await mkdtemp(join(tmpdir(), 'prl-migrate-test-'));
  scratchDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, sql, 'utf8');
  const written = await readFile(path, 'utf8');
  assert.equal(written, sql, 'the fixture file must be on disk before it is used');
  return { version: name, number: name.slice(0, 4), path, sql: written, checksum: 'sha256:fixture' };
}

/**
 * A driver error shaped the way postgres.js throws one.
 *
 * The fields are the ones PostgreSQL's ErrorResponse carries and the driver copies onto the
 * error (`Object.assign(this, x)` in its `errors.js`), so this is the real shape rather than a
 * convenient one. `position` is a 1-based index into the statement, which for this runner is the
 * whole file.
 */
function driverError(message, fields = {}) {
  return Object.assign(new Error(message), { name: 'PostgresError', severity: 'ERROR', ...fields });
}

/**
 * A connection handle that gets as far as the file and then fails on it.
 *
 * `begin` runs the callback rather than short-circuiting, so the assertions below are made about
 * the real `applyFile` path — the `lock_timeout` statement runs, the file is sent through
 * `unsafe`, and only then does anything go wrong. `calls` is what proves the path was exercised
 * rather than a rejection arriving from somewhere earlier.
 */
function handleThatFailsOnTheFile(error, calls) {
  const tx = Object.assign(
    (strings) => {
      calls.push(
        `tagged:${String(strings?.raw?.[0] ?? '')
          .trim()
          .slice(0, 17)}`,
      );
      return Promise.resolve([]);
    },
    {
      unsafe: (text) => {
        calls.push(`unsafe:${text.length}`);
        return Promise.reject(error);
      },
    },
  );
  return { begin: (fn) => fn(tx) };
}

/**
 * The error a rejected call produced, rather than the fact that it rejected.
 *
 * `assert.rejects` resolves to `undefined`, and every assertion here is about what the message
 * SAYS. A test that only knew the call had rejected would pass against the defect.
 */
async function rejectionOf(fn) {
  const outcome = await fn().then(
    () => null,
    (error) => error,
  );
  assert.ok(outcome instanceof Error, 'the call was expected to reject and did not');
  return outcome;
}

/**
 * The property: this text is enough to find the file and the fault without a second question.
 *
 * Written as a function because it is used twice — once on the message the runner produces now,
 * and once, in `assert.throws`, on the message it produced before. That second call is the
 * negative control: if these assertions were satisfiable by any old error text, they would prove
 * nothing about the change.
 */
function assertNamesTheFile(text, file, expected) {
  assert.match(text, new RegExp(file.version.replace(/\./g, '\\.')), 'the message must name the file');
  assert.match(text, /file:/, 'the message must show a path to open');
  assert.match(text, new RegExp(file.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the path must be real');
  if (expected.line !== undefined) {
    assert.match(text, new RegExp(`:${expected.line}:${expected.column}\\b`), 'line and column');
    assert.ok(text.includes(expected.statement), `the offending statement must be echoed: ${text}`);
    assert.match(text, /\^/, 'a caret must point at the column');
  }
  if (expected.code !== undefined) assert.match(text, new RegExp(`code:\\s+${expected.code}`));
}

test('a migration that fails names the file, the line, the statement and the SQLSTATE', async () => {
  // `creat` rather than `create`: a typo is the failure this reporting exists for, and it is the
  // one kind that carries a cursor position, so it exercises the whole message.
  const sql = [
    '-- A deliberately broken migration.',
    'create table prl.first (id text primary key);',
    '',
    'creat table prl.second (id text primary key);',
    '',
  ].join('\n');
  const file = await brokenMigration('0099_deliberately_broken.sql', sql);
  const position = sql.indexOf('creat table') + 1;
  assert.ok(position > 1, 'the fixture must actually contain the broken statement');

  const calls = [];
  const handle = handleThatFailsOnTheFile(
    driverError('syntax error at or near "creat"', { code: '42601', position: String(position) }),
    calls,
  );

  const thrown = await rejectionOf(() => applyFile(handle, file, true, 'migration'));
  const message = String(thrown?.message ?? thrown);

  // The path was exercised: the transaction opened, the lock timeout was set, and the whole file
  // went through `unsafe`. Without this, a rejection thrown before any of that would satisfy
  // every assertion below.
  // Two set_config statements, not one: the lock timeout, and the transaction-local witness
  // `applyFile` reads back to prove the file did not end the transaction under it.
  assert.deepEqual(calls, ['tagged:select set_config', 'tagged:select set_config', `unsafe:${sql.length}`]);

  assertNamesTheFile(message, file, {
    line: 4,
    column: 1,
    statement: 'creat table prl.second',
    code: '42601',
  });
  assert.match(message, /rolled back|as it was before/i, 'an operator must be told what state they are in');

  // NEGATIVE CONTROL. This is the message the runner printed before this change — the bare driver
  // `message`, which is exactly what the top-level handler used to reach for. Every assertion
  // above must fail against it, or they are not assertions about anything.
  assert.throws(
    () =>
      assertNamesTheFile('syntax error at or near "creat"', file, {
        line: 4,
        column: 1,
        statement: 'creat table prl.second',
        code: '42601',
      }),
    /must name the file/,
    'the old message named nothing, and this check has to be able to say so',
  );
});

test('a failure with no cursor position still names the file', async () => {
  // The defect's own example. `42P07` carries no `position`, so this is the case where a message
  // that only knew how to point at a character would have had nothing to say at all.
  const sql = 'create table prl.users (id text primary key);\n';
  const file = await brokenMigration('0001_initial.sql', sql);
  const calls = [];
  const handle = handleThatFailsOnTheFile(
    driverError('relation "users" already exists', { code: '42P07' }),
    calls,
  );

  const thrown = await rejectionOf(() => applyFile(handle, file, true, 'migration'));
  const message = String(thrown?.message ?? thrown);
  assert.ok(calls.length === 3, `the file must have been sent before it failed, saw ${calls.join(', ')}`);

  assertNamesTheFile(message, file, { code: '42P07' });
  assert.match(message, /relation "users" already exists/, 'the driver’s own words are still shown');
  // No position means no caret, rather than a caret pointing confidently at character one.
  assert.doesNotMatch(message, /\^/);

  assert.throws(
    () => assertNamesTheFile('relation "users" already exists', file, { code: '42P07' }),
    /must name the file/,
    'the negative control: the old message is the defect, verbatim',
  );
});

/**
 * A handle whose file SUCCEEDS but whose transaction did not survive it.
 *
 * `set_config(..., true)` is transaction-local, so a file containing `COMMIT;` leaves
 * `current_setting` with nothing to return. This stub models exactly that: the witness write is
 * accepted, `unsafe` resolves, and the read-back comes up empty — which is what PostgreSQL
 * actually does once the transaction has been closed underneath the runner.
 */
function handleWhoseTransactionEscapes(calls) {
  let wrote = 0;
  const tx = Object.assign(
    (strings) => {
      const text = String(strings?.raw?.[0] ?? '').trim();
      calls.push(`tagged:${text.slice(0, 17)}`);
      // The second set_config is the witness write; the third tagged call is the read-back.
      if (text.startsWith('select current_setting')) return Promise.resolve([{ value: null }]);
      wrote += 1;
      return Promise.resolve([]);
    },
    {
      unsafe: (text) => {
        calls.push(`unsafe:${text.length}`);
        return Promise.resolve([]);
      },
    },
  );
  return { begin: (fn) => fn(tx), wrote: () => wrote };
}

test('NEGATIVE CONTROL: a file that ends its own transaction is refused, and the message says so', async () => {
  // ## Reproduced, against the pre-fix runner, on a real PostgreSQL 16
  //
  //   db/migrations/0009_rev_commit.sql:
  //     CREATE TABLE prl.rev_half_a (id text primary key);
  //     COMMIT;
  //     CREATE TABLE prl.rev_half_b (id text primary key);
  //     CREATE TABLE prl.rev_half_b (id text primary key);   -- deliberate duplicate
  //
  //   ✗ migration 0009_rev_commit.sql failed. Nothing it contained was applied.
  //     error:  relation "rev_half_b" already exists
  //   Each file is applied inside one transaction, so that transaction has been rolled back and
  //   this database is exactly as it was before the run started.
  //
  // `prl.rev_half_a` was present afterwards and prl.schema_migrations had no row, so the
  // sentence was false in both halves. The retry — which is what a deploy pipeline does — then
  // failed on `relation "rev_half_a" already exists`, and `up` could not succeed again.
  //
  // The old code cannot pass this test: without the witness read-back there is nothing to
  // detect, `applyFile` resolves, and `rejectionOf` fails its own `instanceof Error` assertion.
  const file = await brokenMigration('0099_commits_halfway.sql', 'create table prl.a (id text);\nCOMMIT;\n');
  const calls = [];
  const handle = handleWhoseTransactionEscapes(calls);

  const thrown = await rejectionOf(() => applyFile(handle, file, true, 'migration'));
  const message = String(thrown?.message ?? thrown);

  assert.match(message, /ENDED ITS OWN TRANSACTION/, 'the headline must not say "nothing was applied"');
  assert.doesNotMatch(
    message,
    /Nothing it contained was applied|exactly as it was before/,
    'the false reassurance is the defect; it must not survive anywhere in the message',
  );
  assert.match(message, /DURABLE/, 'the operator must be told the committed half is still there');
  assert.match(message, /schema_migrations/, 'and that no ledger row was written, so a retry replays it');
  assertNamesTheFile(message, file, {});

  // The ledger insert must NOT have been attempted: recording a version for a file whose first
  // half committed and whose second half may not have run is the worst of both.
  assert.ok(
    !calls.some((call) => call.startsWith('tagged:insert')),
    `no ledger write may be attempted, saw ${calls.join(', ')}`,
  );
});

describe('reset refuses until it is told which database it is emptying', () => {
  // ## Reproduced, against the pre-fix runner, on a real PostgreSQL 16
  //
  //   DATABASE_MIGRATION_URL=<a database holding 944,297 rows> node .../migrate.mjs reset
  //     ! dropping schema prl in database "poker_risk_lab_restored" as "postgres"
  //     ✓ schema prl dropped
  //   select count(*) from prl.hands  →  68677 before, 0 after
  //
  // NODE_ENV was unset in that shell; nothing else was needed. The only guard was
  // `NODE_ENV === 'production'`, which describes the process rather than the target, and
  // `pnpm run db:reset` loads a checked-in .env that sets NODE_ENV=development.
  it('NEGATIVE CONTROL: an unconfirmed reset is refused, and the message names the database', () => {
    assert.throws(
      () => refuseUnconfirmedReset('poker_risk_lab', null),
      (error) => {
        assert.match(error.message, /poker_risk_lab/, 'the target must be named so a typo is visible');
        assert.match(error.message, /--confirm-database poker_risk_lab/, 'and the exact fix shown');
        assert.match(error.message, /NODE_ENV is not a guard/, 'and why the old guard was not one');
        return true;
      },
    );
  });

  it('NEGATIVE CONTROL: a confirmation for a DIFFERENT database is refused', () => {
    // The property that makes the flag worth having: an acknowledgement recalled from shell
    // history is bound to the database it was typed for and cannot empty another one.
    assert.throws(
      () => refuseUnconfirmedReset('poker_risk_lab_prod', 'poker_risk_lab_dev'),
      /You named "poker_risk_lab_dev", but this connection is to "poker_risk_lab_prod"/,
    );
  });

  it('POSITIVE CONTROL: the matching name passes', () => {
    assert.doesNotThrow(() => refuseUnconfirmedReset('poker_risk_lab', 'poker_risk_lab'));
  });

  it('parses the flag in both spellings, and refuses it without a value', () => {
    assert.equal(parseArgs(['reset', '--confirm-database', 'x']).confirmDatabase, 'x');
    assert.equal(parseArgs(['reset', '--confirm-database=x']).confirmDatabase, 'x');
    assert.equal(parseArgs(['up']).confirmDatabase, null);
    assert.throws(() => parseArgs(['reset', '--confirm-database']), /needs the name/);
  });
});

test('a role file and a seed file are named by their own labels, not as migrations', async () => {
  // `roles` and `seed` share `applyFile`, and a message that called a seed failure a "migration"
  // sends an operator to db/migrations to look for a file that is not there.
  const file = await brokenMigration('0001_reference_data.sql', 'insert into prl.thing values (1);\n');
  const handle = handleThatFailsOnTheFile(driverError('boom', { code: '42601' }), []);
  const thrown = await rejectionOf(() => applyFile(handle, file, false, 'seed file'));
  assert.match(String(thrown?.message), /^seed file 0001_reference_data\.sql failed/);
});

test('locateInSource maps a cursor onto the line an editor would show', () => {
  const sql = 'alpha\nbeta\ngamma\n';
  assert.deepEqual(locateInSource(sql, 1), { line: 1, column: 1, text: 'alpha' });
  // The first character of line 2: 'alpha' is 5 characters plus the newline.
  assert.deepEqual(locateInSource(sql, 7), { line: 2, column: 1, text: 'beta' });
  assert.deepEqual(locateInSource(sql, 10), { line: 2, column: 4, text: 'beta' });
  assert.deepEqual(locateInSource(sql, 12), { line: 3, column: 1, text: 'gamma' });

  // Everything that is not a usable cursor is null, rather than a confident guess at line 1.
  for (const absent of [undefined, null, '', '0', 'NaN', -1, sql.length + 2, 1.5]) {
    assert.equal(locateInSource(sql, absent), null, `should not locate ${String(absent)}`);
  }
});

test('an irreversible migration declares itself with a reason, not a bare marker', () => {
  const destructive = 'ALTER TABLE prl.users DROP COLUMN display_name;';
  assert.equal(declaresIrreversible(destructive), false);
  assert.equal(
    declaresIrreversible(`-- prl:irreversible:\n${destructive}`),
    false,
    'a marker with no reason is a checkbox, not a decision',
  );
  assert.equal(
    declaresIrreversible(
      `-- prl:irreversible: display_name has been unused since 0031 and the values\n-- cannot be recomputed; the way back is a restore.\n${destructive}`,
    ),
    true,
  );
});
