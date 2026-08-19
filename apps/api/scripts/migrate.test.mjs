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
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { declaresIrreversible, findIrreversibleStatements, stripSqlComments } from './migrate.mjs';

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
