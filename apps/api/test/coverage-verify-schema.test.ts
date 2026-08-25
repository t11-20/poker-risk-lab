/**
 * `apps/api/scripts/verify-schema.mjs`, proved capable of failing.
 *
 * ## The hole this closes
 *
 * `pnpm run db:verify` is a release gate: it asks the live database whether the security properties
 * the threat model claims are actually true — no column can hold the deck or the salts, no raw
 * token or invite code is stored, the concurrency indexes exist, `rooms.visibility` admits one
 * value, and the runtime role is genuinely least-privilege. It had no test, and the release audit
 * found four other gates in this repository that could not fail. A schema guard that has never been
 * seen to reject anything is worth nothing: it is indistinguishable from `exit 0`.
 *
 * So every check this file exercises is exercised by *breaking the schema* and watching the script
 * refuse. Each hostile change is applied to a throwaway database this file creates and drops, the
 * script is run, its exit code and its finding are asserted, the change is reverted, and the script
 * is run again to confirm it is content — which is what makes each failure attributable to the
 * change rather than to anything else that happened to be wrong.
 *
 * ## The hostile change the loop cannot make
 *
 * Every case in `HOSTILE_CHANGES` is applied to a table the runtime role already has a grant on,
 * and the script is run as the schema owner — who sees the whole schema whichever catalogue is
 * asked. So none of them could detect the defect that mattered most: `information_schema` is
 * filtered by the CONNECTING ROLE's privileges, `pnpm run db:verify` connects as a member of
 * `prl_app`, and a table added by a later migration is granted nothing by default. The verifier
 * was therefore blind, by default, to exactly the tables nobody had reviewed. The suite named
 * "a table the connecting role cannot see" is the negative control for that, and it runs the
 * script as `prl_app` because running it as the owner is what hid the hole.
 *
 * ## What is deliberately NOT broken
 *
 * `prl_app`'s role *attributes* — `rolsuper`, `rolcreatedb`, `rolcreaterole`. Those are cluster-wide
 * in PostgreSQL: making one of them true to watch the script complain would grant it in every
 * database on the server, including the one the rest of this suite is using, and a test that
 * escalates a shared role's privileges is a bad trade whatever it proves. The privilege checks that
 * *are* database-scoped — CREATE on the schema, TRUNCATE on a table — are exercised in full, and
 * they are the ones an ordinary mistake in a migration would actually produce.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql } from '../src/db.ts';
import { generateOpaqueSecret } from '../src/repositories/ids.ts';
import { adminDatabaseUrl, databaseSkip } from './helpers/database.ts';

const execFileAsync = promisify(execFile);

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(API_DIR, '..', '..');
const VERIFY = join(API_DIR, 'scripts', 'verify-schema.mjs');
const MIGRATE = join(API_DIR, 'scripts', 'migrate.mjs');

// The schema-owning identity: this file creates throwaway databases and applies hostile
// ALTER/GRANT/REVOKE changes to prove the gate can fail. The runtime role deliberately
// cannot do any of that, so asking for it here is what lets the rest of the suite run as a
// prl_app member without widening a single grant.
const databaseUrl = adminDatabaseUrl();
let maintenance: Sql | null = null;
let skipReason: string | false = databaseSkip('the schema verifier');

function clientFor(url: string): Sql {
  return createDatabaseClient(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
      SESSION_COOKIE_SECRET: TEST_SECRET,
      DATABASE_POOL_MAX: '2',
      DATABASE_STATEMENT_TIMEOUT_MS: '30000',
    }),
  );
}

function maintenanceUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

if (databaseUrl !== undefined) {
  try {
    const probe = clientFor(maintenanceUrlFor(databaseUrl));
    await probe`select 1`;
    maintenance = probe;
  } catch (error) {
    skipReason = `the cluster's maintenance database is not reachable (${
      error instanceof Error ? error.name : 'error'
    })`;
  }
}

if (skipReason !== false) {
  console.info(`[coverage-verify-schema.test.ts] skipping database-backed tests: ${skipReason}`);
}

const dbOptions = { skip: skipReason };

after(async () => {
  if (maintenance !== null) await maintenance.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// Throwaway databases
// ---------------------------------------------------------------------------

interface Throwaway {
  readonly name: string;
  readonly url: string;
  readonly sql: Sql;
}

/**
 * A database of this file's own, so a hostile schema change is never applied anywhere real.
 *
 * The name comes from the same CSPRNG the repositories use and is matched against a strict pattern
 * before it is interpolated: `CREATE DATABASE` cannot take a bind parameter, so `sql(name)` —
 * postgres.js's identifier quoting — is what puts it in the statement.
 */
async function createThrowaway(): Promise<Throwaway> {
  const handle = maintenance;
  assert.ok(handle !== null, 'these tests need a maintenance connection');
  assert.ok(databaseUrl !== undefined);
  const name = `prl_verify_test_${generateOpaqueSecret(6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')}`;
  assert.match(name, /^prl_verify_test_[a-z0-9]{4,32}$/, 'refusing to use that as an identifier');
  try {
    await handle`create database ${handle(name)}`;
  } catch (error) {
    assert.fail(
      `could not create a throwaway database (${error instanceof Error ? error.message : String(error)}).\n` +
        'This file applies hostile schema changes in order to prove the verifier rejects them, so it ' +
        'needs a database of its own — which means the role in DATABASE_URL needs CREATEDB.',
    );
  }
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const target = url.toString();
  return { name, url: target, sql: clientFor(target) };
}

async function dropThrowaway(throwaway: Throwaway): Promise<void> {
  const handle = maintenance;
  assert.ok(handle !== null);
  await throwaway.sql.end({ timeout: 5 });
  await handle`drop database if exists ${handle(throwaway.name)} with (force)`;
}

interface RunResult {
  readonly code: number;
  readonly output: string;
}

async function run(script: string, args: readonly string[], url: string | undefined): Promise<RunResult> {
  // Both connection strings are filtered out of the inherited environment and only `url` is put
  // back. `DATABASE_MIGRATION_URL` matters as much as `DATABASE_URL` here: the migration runner
  // prefers it, and a developer machine that sets it would send the `up` below to a real database
  // instead of to the throwaway one this file is about to vandalise.
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'DATABASE_URL' && entry[0] !== 'DATABASE_MIGRATION_URL',
      ),
    ),
    NO_COLOR: '1',
  };
  if (url !== undefined) env['DATABASE_URL'] = url;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      env,
      cwd: REPO_ROOT,
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const verify = (url: string | undefined): Promise<RunResult> => run(VERIFY, [], url);

/** A throwaway database with every migration applied, dropped however the body ends. */
async function withMigratedDatabase(use: (throwaway: Throwaway) => Promise<void>): Promise<void> {
  const throwaway = await createThrowaway();
  try {
    const migrated = await run(MIGRATE, ['up'], throwaway.url);
    assert.equal(migrated.code, 0, `the throwaway database could not be migrated:\n${migrated.output}`);
    await use(throwaway);
  } finally {
    await dropThrowaway(throwaway);
  }
}

/** The verifier is content with this schema. The control every hostile case is measured against. */
async function assertPasses(throwaway: Throwaway, when: string): Promise<void> {
  const result = await verify(throwaway.url);
  assert.equal(result.code, 0, `${when}: the verifier should pass but did not:\n${result.output}`);
  assert.match(result.output, /every documented schema security property holds/);
}

/**
 * The same DSN, but the verifier runs as `prl_app` — the privileges a deployment actually gives it.
 *
 * `pnpm run db:verify` connects as `DATABASE_URL`, which RUNBOOK §5 makes `prl_api`: a login role
 * that is a member of `prl_app` and holds nothing of its own. This file's DSN is the schema-owning
 * identity instead, because it has to be able to apply hostile DDL — and an owner sees everything
 * in `pg_catalog` AND everything in `information_schema`, which is precisely the difference the
 * test below exists to catch. Running the script under the runtime role is what puts it back.
 *
 * Done with the `options` startup parameter rather than a second login role, for two reasons: a
 * role is cluster-wide, so creating one to prove a point in one throwaway database leaks out of
 * the database this file is allowed to vandalise; and `prl_app` is NOLOGIN on purpose, so there
 * is no password to put in a test file. `SET ROLE` is exactly what a login role's membership does
 * at connection time, and postgres.js forwards any query parameter it does not recognise as a
 * startup parameter, which is how `-c role=prl_app` reaches the server.
 */
function asRuntimeRole(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', '-c role=prl_app');
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// The hostile changes
// ---------------------------------------------------------------------------

interface HostileChange {
  readonly what: string;
  /** The finding the verifier has to produce. */
  readonly expect: RegExp;
  readonly apply: (sql: Sql) => Promise<void>;
  readonly revert: (sql: Sql) => Promise<void>;
}

/**
 * Every change is written as a literal DDL statement inside a tagged template — no value is
 * interpolated anywhere, so nothing here is a hole in the parameterisation rule that
 * `src/db.ts` states at the top.
 */
const HOSTILE_CHANGES: readonly HostileChange[] = [
  {
    what: 'a column that would persist the deck order',
    expect: /forbidden column: hands\.deck_order .*would persist deck order/,
    apply: async (sql) => {
      await sql`alter table prl.hands add column deck_order jsonb`;
    },
    revert: async (sql) => {
      await sql`alter table prl.hands drop column deck_order`;
    },
  },
  {
    what: 'a column that would persist the commitment salts',
    expect: /forbidden column: hand_seats\.commitment_salts .*sealed Merkle leaves/,
    apply: async (sql) => {
      await sql`alter table prl.hand_seats add column commitment_salts bytea`;
    },
    revert: async (sql) => {
      await sql`alter table prl.hand_seats drop column commitment_salts`;
    },
  },
  {
    what: 'a column that would hold a raw session token',
    expect: /forbidden column: sessions\.token .*never be stored, only its hash/,
    apply: async (sql) => {
      await sql`alter table prl.sessions add column token text`;
    },
    revert: async (sql) => {
      await sql`alter table prl.sessions drop column token`;
    },
  },
  {
    what: 'a column that would hold a raw invite code',
    expect: /forbidden column: rooms\.invite_code .*never be stored, only its hash/,
    apply: async (sql) => {
      await sql`alter table prl.rooms add column invite_code text`;
    },
    revert: async (sql) => {
      await sql`alter table prl.rooms drop column invite_code`;
    },
  },
  {
    what: 'a column that would hold a raw IP address',
    expect: /forbidden column: sessions\.ip_address .*only a keyed hash/,
    apply: async (sql) => {
      await sql`alter table prl.sessions add column ip_address text`;
    },
    revert: async (sql) => {
      await sql`alter table prl.sessions drop column ip_address`;
    },
  },
  {
    what: 'a column that would hold a raw user agent',
    expect: /forbidden column: sessions\.user_agent .*only a keyed hash/,
    apply: async (sql) => {
      await sql`alter table prl.sessions add column user_agent text`;
    },
    revert: async (sql) => {
      await sql`alter table prl.sessions drop column user_agent`;
    },
  },
  {
    what: 'a hash column changed to a type that is not a digest',
    expect: /wrong hash type: sessions\.token_hash is text, expected bytea/,
    apply: async (sql) => {
      await sql`alter table prl.sessions alter column token_hash type text using encode(token_hash, 'hex')`;
    },
    revert: async (sql) => {
      await sql`alter table prl.sessions alter column token_hash type bytea using decode(token_hash, 'hex')`;
    },
  },
  {
    what: 'the database-level idempotency index removed',
    expect: /missing idempotency index/,
    apply: async (sql) => {
      await sql`drop index prl.hand_actions_client_action_id_key`;
    },
    // Restored exactly as `db/migrations/0002_indexes_and_constraints.sql` declares it. Copied
    // rather than captured from the catalogue, because re-executing a captured `indexdef` would
    // mean `.unsafe()`, and this database is discarded either way.
    revert: async (sql) => {
      await sql`
        create unique index hand_actions_client_action_id_key
          on prl.hand_actions (hand_id, action_id)
          where action_id is not null
      `;
    },
  },
  {
    what: 'the seating index removed, so two players could hold one chair',
    expect: /missing seating index/,
    apply: async (sql) => {
      await sql`drop index prl.room_members_live_seat_key`;
    },
    revert: async (sql) => {
      await sql`
        create unique index room_members_live_seat_key
          on prl.room_members (room_id, seat)
          where seat is not null and left_at is null
      `;
    },
  },
  {
    /**
     * The exact regression `db/migrations/0004_account_deletion.sql` exists to prevent.
     *
     * `room_members.user_id` was `ON DELETE RESTRICT`, and a foreign key has no predicate — so a
     * membership a learner ended months ago restricted their erasure exactly as hard as one they
     * were sitting in. Every learner who had ever joined a table was undeletable, and the failure
     * arrived as a bare `23503` that nothing mapped. Putting the constraint back the old way here
     * proves the check that now catches it can actually fail.
     */
    what: 'a foreign key to prl.users that would make an account undeletable again',
    expect: /user reference: room_members: room_members_user_id_fkey is ON DELETE RESTRICT/,
    apply: async (sql) => {
      await sql`alter table prl.room_members drop constraint room_members_user_id_fkey`;
      await sql`
        alter table prl.room_members
          add constraint room_members_user_id_fkey
          foreign key (user_id) references prl.users (id) on delete restrict
      `;
    },
    revert: async (sql) => {
      await sql`alter table prl.room_members drop constraint room_members_user_id_fkey`;
      await sql`
        alter table prl.room_members
          add constraint room_members_user_id_fkey
          foreign key (user_id) references prl.users (id) on delete cascade
      `;
    },
  },
  {
    what: 'the invite-only constraint removed, which is how public matchmaking would ship',
    expect: /missing visibility constraint/,
    apply: async (sql) => {
      await sql`alter table prl.rooms drop constraint rooms_visibility_invite_only`;
    },
    revert: async (sql) => {
      await sql`
        alter table prl.rooms
          add constraint rooms_visibility_invite_only check (visibility = 'invite_only')
      `;
    },
  },
  {
    what: 'the invite-only constraint widened to permit a second value',
    expect: /visibility constraint: permits more than invite_only/,
    apply: async (sql) => {
      await sql`alter table prl.rooms drop constraint rooms_visibility_invite_only`;
      await sql`
        alter table prl.rooms
          add constraint rooms_visibility_invite_only
          check (visibility in ('invite_only', 'public'))
      `;
    },
    revert: async (sql) => {
      await sql`alter table prl.rooms drop constraint rooms_visibility_invite_only`;
      await sql`
        alter table prl.rooms
          add constraint rooms_visibility_invite_only check (visibility = 'invite_only')
      `;
    },
  },
  {
    what: 'CREATE on the schema granted to the runtime role',
    expect: /prl_app: holds CREATE on schema prl/,
    apply: async (sql) => {
      await sql`grant create on schema prl to prl_app`;
    },
    revert: async (sql) => {
      await sql`revoke create on schema prl from prl_app`;
    },
  },
  {
    what: 'TRUNCATE granted to the runtime role',
    expect: /prl_app: can TRUNCATE users/,
    apply: async (sql) => {
      await sql`grant truncate on prl.users to prl_app`;
    },
    revert: async (sql) => {
      await sql`revoke truncate on prl.users from prl_app`;
    },
  },
  {
    what: 'a table in the schema owned by the runtime role, which could then drop it',
    // Not pinned to a count: `ALTER TABLE ... OWNER TO` carries the table's indexes with it, so
    // one hostile change moves several relations. The finding that matters is that ownership of
    // `audit_log` — the tamper-evident record — is reported at all.
    expect: /prl_app: owns \d+ relation\(s\), so it can DROP them:.*audit_log/,
    apply: async (sql) => {
      await sql`alter table prl.audit_log owner to prl_app`;
    },
    /**
     * The GRANT has to be re-issued, and finding that out is what the grant matrix check bought.
     *
     * `ALTER TABLE ... OWNER TO prl_app` makes `prl_app` the owner, and PostgreSQL drops the now
     * redundant explicit grant to it from the ACL. Handing ownership back to `prl_migrator` does
     * NOT put that entry back, so the revert left `audit_log` with no grant to the runtime role at
     * all — the security-audit trail unwritable by the only role that writes to it.
     *
     * This test reverted that way from the day it was written and passed every time, because
     * nothing in the verifier looked at grants: `assertPasses` after the revert only ever proved
     * that ownership was restored. Check 10 caught it on its first run against the full suite.
     */
    revert: async (sql) => {
      await sql`alter table prl.audit_log owner to prl_migrator`;
      await sql`grant select, insert on prl.audit_log to prl_app`;
    },
  },
  {
    /**
     * The over-grant direction of the matrix.
     *
     * `prl.hands` is SELECT/INSERT/UPDATE and 0001 says why in as many words: "deal, advance,
     * settle. No DELETE". A DELETE here would let the request path — and therefore an injection
     * that reaches it — remove a hand that other people played, and it looks like nothing at all in
     * a migration diff. Check 6 could never see it: it asks only about TRUNCATE.
     */
    what: 'DELETE on prl.hands granted to the runtime role, which no migration ever decided',
    expect: /grant matrix: prl_app holds SELECT INSERT UPDATE DELETE on hands, expected SELECT INSERT UPDATE/,
    apply: async (sql) => {
      await sql`grant delete on prl.hands to prl_app`;
    },
    revert: async (sql) => {
      await sql`revoke delete on prl.hands from prl_app`;
    },
  },
  {
    /**
     * The missing-grant direction, on the table where it costs the most.
     *
     * A new table is granted nothing by default — 0001 says so — so this is what a migration that
     * forgot its GRANT looks like. `prl.room_ownership` is the room lease: the API refuses to serve
     * a room whose lease it cannot take, so a missing grant here does not degrade a feature, it
     * refuses every room in the deployment. That failure would otherwise arrive as a runtime
     * `permission denied` on a table nothing else mentions, with `db:verify` having passed.
     */
    what: 'the room-lease table left with no grants, the default state of a new table',
    expect: /grant matrix: prl_app holds nothing on room_ownership, expected SELECT INSERT UPDATE DELETE/,
    apply: async (sql) => {
      await sql`revoke all on prl.room_ownership from prl_app`;
    },
    revert: async (sql) => {
      await sql`grant select, insert, update, delete on prl.room_ownership to prl_app`;
    },
  },
  {
    what: 'an aggregate quiz score column, which is what would let a quiz gate progress',
    expect: /gamification column: quiz_attempts\.score/,
    apply: async (sql) => {
      await sql`alter table prl.quiz_attempts add column score integer`;
    },
    revert: async (sql) => {
      await sql`alter table prl.quiz_attempts drop column score`;
    },
  },
];

describe('verify-schema.mjs — it passes a correct schema and rejects a hostile one', dbOptions, () => {
  it('accepts the schema the migrations produce', async () => {
    await withMigratedDatabase(async (throwaway) => {
      const result = await verify(throwaway.url);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /every documented schema security property holds/);
      // The notes are what tell a reader the script looked at anything at all. A run that found no
      // columns and no indexes would also report no failures.
      assert.match(result.output, /\d+ columns across the prl schema/);
      assert.match(result.output, /\d+ indexes/);
      assert.match(result.output, /checked \d+ tables for prl_app privileges/);
      // And that the grant matrix looked at every table rather than at the ones it happened to
      // find. A matrix that silently checked nothing would report no failures either.
      assert.match(result.output, /prl_app holds exactly the declared verbs on all \d+ tables/);
    });
  });

  for (const change of HOSTILE_CHANGES) {
    it(`rejects ${change.what}`, async () => {
      await withMigratedDatabase(async (throwaway) => {
        await assertPasses(throwaway, 'before the change');

        await change.apply(throwaway.sql);
        const rejected = await verify(throwaway.url);
        assert.equal(
          rejected.code,
          1,
          `the verifier accepted ${change.what}, which makes it a gate that cannot fail:\n${rejected.output}`,
        );
        assert.match(rejected.output, change.expect);
        assert.match(rejected.output, /schema property\/properties violated/);

        // Reverting and passing again is what attributes the failure to this change alone.
        await change.revert(throwaway.sql);
        await assertPasses(throwaway, 'after the revert');
      });
    });
  }
});

describe('verify-schema.mjs — a table the connecting role cannot see', dbOptions, () => {
  /**
   * The negative control for the privilege filter, and the one case the loop above cannot make.
   *
   * Every hostile change above is applied to a table `prl_app` already has a grant on, and the
   * verifier is run as the schema owner, who sees everything either way. So none of them could
   * ever have caught this: `information_schema.columns` is filtered by the CURRENT ROLE's
   * privileges, `db/migrations/0001_initial.sql` says a table added by a later migration is
   * granted nothing until somebody writes the GRANT, and `pnpm run db:verify` connects as a
   * member of `prl_app`. A new table is therefore invisible to the gate by default — and checks
   * 1, 2 and 7 iterate exactly that column list.
   *
   * `prl.hand_deck_cache` is the table an auditor built to demonstrate it: created by the
   * migrator with no grants, it produced four violations as the owner and exit 0 as `prl_api`.
   * The same database, and the property the script calls its most important one — no column may
   * hold the deck or the salts — answering "fine" about the one table holding both.
   *
   * The three assertions in the middle are not decoration. Without them, a future GRANT (or a
   * change of DSN identity) could make the table visible again, and this test would go on passing
   * as an ordinary duplicate of "rejects a column that would persist the deck order" while
   * silently no longer covering the blind case at all.
   */
  it('fails on a forbidden column in a table it has no grant on, run as prl_app', async () => {
    await withMigratedDatabase(async (throwaway) => {
      const runtimeUrl = asRuntimeRole(throwaway.url);

      // The control: as the runtime role, the migrated schema passes. If this fails, the run is
      // not measuring the privilege filter — it is measuring a broken connection.
      const clean = await verify(runtimeUrl);
      assert.equal(clean.code, 0, `the migrated schema should pass as prl_app:\n${clean.output}`);

      // Created as prl_migrator so the table is owned the way every other relation is — check 6b
      // would otherwise fail for the unrelated reason that the owner is wrong, and the finding
      // this test is about would arrive alongside a distraction. `set local` is undone by the
      // commit, so the pooled connection is not left wearing another role.
      await throwaway.sql.begin(async (tx) => {
        await tx`set local role prl_migrator`;
        await tx`
          create table prl.hand_deck_cache (
            id text primary key,
            deck jsonb,
            deck_salts jsonb,
            total_score integer
          )
        `;
      });

      // It really is invisible to the runtime role: pg_catalog lists its four columns, and
      // information_schema — asked as prl_app — lists none of them.
      const seen = await throwaway.sql.begin(async (tx) => {
        await tx`set local role prl_app`;
        const [visible] = await tx<{ count: number }[]>`
          select count(*)::int as count from information_schema.columns
          where table_schema = 'prl' and table_name = 'hand_deck_cache'
        `;
        const [real] = await tx<{ count: number }[]>`
          select count(*)::int as count
          from pg_catalog.pg_attribute att
          join pg_catalog.pg_class cls on cls.oid = att.attrelid
          join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
          where nsp.nspname = 'prl' and cls.relname = 'hand_deck_cache'
            and att.attnum > 0 and not att.attisdropped
        `;
        return { visible: visible?.count ?? -1, real: real?.count ?? -1 };
      });
      assert.equal(seen.real, 4, 'the table should have four columns in pg_catalog');
      assert.equal(
        seen.visible,
        0,
        'prl_app can see this table, so this run no longer exercises the privilege filter — ' +
          'something granted it, and the negative control has quietly become a duplicate',
      );

      // The finding. Against a verifier that reads `information_schema.columns` this run exits 0.
      const rejected = await verify(runtimeUrl);
      assert.equal(
        rejected.code,
        1,
        'the verifier passed a table holding the deck and the salts because the connecting role ' +
          `could not see it, which is a gate that cannot fail:\n${rejected.output}`,
      );
      assert.match(rejected.output, /forbidden column: hand_deck_cache\.deck — would persist deck order/);
      assert.match(rejected.output, /forbidden column: hand_deck_cache\.deck_salts .*sealed Merkle leaves/);
      assert.match(rejected.output, /gamification column: hand_deck_cache\.total_score/);
      // The count it reports has to be the whole schema's, not the visible subset's.
      assert.match(rejected.output, /columns across the prl schema, read from pg_catalog as prl_app/);
      assert.match(rejected.output, /invisible to prl_app/);

      // Reverting and passing again attributes every one of those findings to this table.
      await throwaway.sql.begin(async (tx) => {
        await tx`set local role prl_migrator`;
        await tx`drop table prl.hand_deck_cache`;
      });
      const reverted = await verify(runtimeUrl);
      assert.equal(reverted.code, 0, `after the revert the verifier should pass:\n${reverted.output}`);
    });
  });

  /**
   * The table list check 6 iterates, asked the same way.
   *
   * This one is NOT a case the old code got wrong, and saying so is the point of the test:
   * `information_schema.tables` includes TRUNCATE in the privilege list its filter tests, so a
   * table `prl_app` can TRUNCATE was always visible to it. Check 6 was sound by coincidence, on a
   * detail of one view definition that nobody had written down. The script now reads `pg_class`
   * there too, and this asserts the finding still arrives — so converting the read cannot have
   * cost the check the one thing it was already doing correctly.
   */
  it('still reports a TRUNCATE grant to prl_app when run as prl_app', async () => {
    await withMigratedDatabase(async (throwaway) => {
      const runtimeUrl = asRuntimeRole(throwaway.url);
      await throwaway.sql`grant truncate on prl.users to prl_app`;
      const rejected = await verify(runtimeUrl);
      assert.equal(rejected.code, 1, `prl_app can TRUNCATE prl.users:\n${rejected.output}`);
      assert.match(rejected.output, /prl_app: can TRUNCATE users/);

      await throwaway.sql`revoke truncate on prl.users from prl_app`;
      const reverted = await verify(runtimeUrl);
      assert.equal(reverted.code, 0, `after the revert the verifier should pass:\n${reverted.output}`);
    });
  });
});

describe('verify-schema.mjs — pointed at the wrong thing', dbOptions, () => {
  it('fails against a database with no schema at all, rather than finding nothing to complain about', async () => {
    // The failure mode this guards: `pnpm run db:verify` run against an empty or wrong database.
    // Every check reads a catalogue, and a catalogue with nothing in it produces no forbidden
    // columns — so a naive verifier would report success on a database with no application in it.
    const throwaway = await createThrowaway();
    try {
      const result = await verify(throwaway.url);
      assert.equal(result.code, 1, `an unmigrated database must not pass:\n${result.output}`);
      assert.match(result.output, /missing hash column: sessions\.token_hash does not exist/);
      assert.match(result.output, /missing idempotency index/);
    } finally {
      await dropThrowaway(throwaway);
    }
  });

  it('refuses to run with no DATABASE_URL, and says how to get one', async () => {
    const result = await verify(undefined);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /DATABASE_URL is not set/);
    assert.match(result.output, /db:setup/);
  });
});
