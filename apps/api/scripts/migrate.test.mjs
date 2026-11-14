/**
 * Tests for migrate.mjs policy: `down` states roll-forward-only, `up` refuses undeclared destructive
 * migrations, and a failed file is named. No database.
 * `applyFile` runs against a stub handle that rejects with the postgres.js error shape. That a live
 * PostgreSQL sends `position` as a string ('25' for line 4 column 1) was checked by hand.
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

async function migrate(args, env = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [MIGRATE, ...args], {
      // DATABASE_URL is not inherited, because answering without one is under test.
      env: { PATH: process.env['PATH'] ?? '', NO_COLOR: '1', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('`down` is a real command that states the roll-forward-only policy', async () => {
  const { code, stdout } = await migrate(['down']);

  assert.equal(code, 1, 'down must fail rather than appear to succeed');

  assert.doesNotMatch(stdout, /Unknown command/i, 'down must be a command, not an unrecognised word');

  assert.match(stdout, /roll-forward only/i);
  assert.match(stdout, /write the next migration/i);
  assert.match(stdout, /restore from backup/i);
  assert.match(stdout, /reset/i);
});

test('`down` answers without a database connection and without DATABASE_URL', async () => {
  const { stdout } = await migrate(['down']);
  // A connection attempt would have complained about the missing URL.
  assert.doesNotMatch(stdout, /DATABASE_URL is not set|DATABASE_MIGRATION_URL/i);
});

test('the usage text names `down` and `roles`', async () => {
  const { code, stdout } = await migrate(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /^\s*down\s+refuses/m);
  assert.match(stdout, /^\s*roles\s+/m);
});

// The real rule allows a destructive file that declares itself, as 0003 must to replace a CHECK.
test('every migration already in db/migrations satisfies the gate `up` applies', async () => {
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

  // A record for reviewers, not an assertion.
  if (declared.length > 0) console.info(`  declared irreversible: ${declared.join('; ')}`);
});

test('a declaration without a reason is not a declaration', () => {
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
  assert.equal(stripped.length, sql.length);
  assert.doesNotMatch(stripSqlComments('/* a /* b */ c */ SELECT 3;'), /[abc]\s/);
});

const scratchDirs = [];

after(async () => {
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
});

// A real file, so the message's path and line can be checked against something openable.
async function brokenMigration(name, sql) {
  const dir = await mkdtemp(join(tmpdir(), 'prl-migrate-test-'));
  scratchDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, sql, 'utf8');
  const written = await readFile(path, 'utf8');
  assert.equal(written, sql, 'the fixture file must be on disk before it is used');
  return { version: name, number: name.slice(0, 4), path, sql: written, checksum: 'sha256:fixture' };
}

// postgres.js copies the ErrorResponse fields onto the error with `Object.assign(this, x)`.
function driverError(message, fields = {}) {
  return Object.assign(new Error(message), { name: 'PostgresError', severity: 'ERROR', ...fields });
}

// `calls` proves the file reached `unsafe`, not that something earlier rejected.
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

// `assert.rejects` resolves to undefined, and these tests need the message.
async function rejectionOf(fn) {
  const outcome = await fn().then(
    () => null,
    (error) => error,
  );
  assert.ok(outcome instanceof Error, 'the call was expected to reject and did not');
  return outcome;
}

// A bare driver message must fail this, which the negative control below shows.
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
  // A typo carries a cursor position, so it exercises the whole message.
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

  // Two set_config calls, the lock timeout and the transaction witness.
  assert.deepEqual(calls, ['tagged:select set_config', 'tagged:select set_config', `unsafe:${sql.length}`]);

  assertNamesTheFile(message, file, {
    line: 4,
    column: 1,
    statement: 'creat table prl.second',
    code: '42601',
  });
  assert.match(message, /rolled back|as it was before/i, 'an operator must be told what state they are in');

  // NEGATIVE CONTROL: a bare driver message names nothing, and the check must say so.
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
  // `42P07` carries no `position`.
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
  assert.doesNotMatch(message, /\^/);

  assert.throws(
    () => assertNamesTheFile('relation "users" already exists', file, { code: '42P07' }),
    /must name the file/,
    'the negative control: the old message is the defect, verbatim',
  );
});

// The file succeeds and the witness read-back is empty, as after a `COMMIT;` in the file.
function handleWhoseTransactionEscapes(calls) {
  let wrote = 0;
  const tx = Object.assign(
    (strings) => {
      const text = String(strings?.raw?.[0] ?? '').trim();
      calls.push(`tagged:${text.slice(0, 17)}`);
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
  // Without the transaction witness this call resolves, and `rejectionOf` fails.
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

  assert.ok(
    !calls.some((call) => call.startsWith('tagged:insert')),
    `no ledger write may be attempted, saw ${calls.join(', ')}`,
  );
});

describe('reset refuses until it is told which database it is emptying', () => {
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
  const file = await brokenMigration('0001_reference_data.sql', 'insert into prl.thing values (1);\n');
  const handle = handleThatFailsOnTheFile(driverError('boom', { code: '42601' }), []);
  const thrown = await rejectionOf(() => applyFile(handle, file, false, 'seed file'));
  assert.match(String(thrown?.message), /^seed file 0001_reference_data\.sql failed/);
});

test('locateInSource maps a cursor onto the line an editor would show', () => {
  const sql = 'alpha\nbeta\ngamma\n';
  assert.deepEqual(locateInSource(sql, 1), { line: 1, column: 1, text: 'alpha' });
  assert.deepEqual(locateInSource(sql, 7), { line: 2, column: 1, text: 'beta' });
  assert.deepEqual(locateInSource(sql, 10), { line: 2, column: 4, text: 'beta' });
  assert.deepEqual(locateInSource(sql, 12), { line: 3, column: 1, text: 'gamma' });

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
