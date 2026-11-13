/**
 * Proves `apps/api/scripts/verify-schema.mjs` (`db:verify`) can fail: each check is exercised by breaking
 * a throwaway database's schema, asserting the finding, reverting, and asserting a pass again.
 * `information_schema` is filtered by the connecting role, so the blind-table case runs as `prl_app`.
 * Role attributes (`rolsuper` etc.) are not broken because they are cluster-wide.
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

// The schema owner, because hostile DDL needs it and the runtime role must not have it.
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

interface Throwaway {
  readonly name: string;
  readonly url: string;
  readonly sql: Sql;
}

/** `CREATE DATABASE` takes no bind parameter, so the name is pattern-checked and identifier-quoted. */
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
  // The migration runner prefers DATABASE_MIGRATION_URL, so an inherited one would migrate a real database.
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

async function assertPasses(throwaway: Throwaway, when: string): Promise<void> {
  const result = await verify(throwaway.url);
  assert.equal(result.code, 0, `${when}: the verifier should pass but did not:\n${result.output}`);
  assert.match(result.output, /every documented schema security property holds/);
}

/**
 * Runs the verifier as `prl_app`, as a deployment does. The owner sees every table in both catalogues.
 * `-c role=prl_app` avoids a second login role, which would be cluster-wide, and `prl_app` is NOLOGIN.
 */
function asRuntimeRole(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', '-c role=prl_app');
  return parsed.toString();
}

interface HostileChange {
  readonly what: string;
  readonly expect: RegExp;
  readonly apply: (sql: Sql) => Promise<void>;
  readonly revert: (sql: Sql) => Promise<void>;
}

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
    // Copied from migration 0002 because re-executing a captured `indexdef` would need `.unsafe()`.
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
    // The regression migration 0004 fixed. RESTRICT made every learner who ever joined a table undeletable.
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
    // Not pinned to a count, because `OWNER TO` moves the table's indexes too.
    expect: /prl_app: owns \d+ relation\(s\), so it can DROP them:.*audit_log/,
    apply: async (sql) => {
      await sql`alter table prl.audit_log owner to prl_app`;
    },
    // Handing ownership back does not restore the explicit grant PostgreSQL dropped, so re-issue it.
    revert: async (sql) => {
      await sql`alter table prl.audit_log owner to prl_migrator`;
      await sql`grant select, insert on prl.audit_log to prl_app`;
    },
  },
  {
    // Over-grant. Migration 0001 gives hands no DELETE, and check 6 only asks about TRUNCATE.
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
    // Missing grant, the default for a new table. Without the lease grant every room is refused.
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
      // A run that read no columns, indexes or tables would also report no failures.
      assert.match(result.output, /\d+ columns across the prl schema/);
      assert.match(result.output, /\d+ indexes/);
      assert.match(result.output, /checked \d+ tables for prl_app privileges/);
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

        await change.revert(throwaway.sql);
        await assertPasses(throwaway, 'after the revert');
      });
    });
  }
});

describe('verify-schema.mjs — a table the connecting role cannot see', dbOptions, () => {
  /**
   * Negative control for the privilege filter. A table with no grant is invisible to `prl_app` in
   * `information_schema`, and against such a verifier this table gave four violations as owner and exit 0
   * as `prl_api`. The visibility assertions stop this from silently becoming a duplicate case.
   */
  it('fails on a forbidden column in a table it has no grant on, run as prl_app', async () => {
    await withMigratedDatabase(async (throwaway) => {
      const runtimeUrl = asRuntimeRole(throwaway.url);

      const clean = await verify(runtimeUrl);
      assert.equal(clean.code, 0, `the migrated schema should pass as prl_app:\n${clean.output}`);

      // Owned by prl_migrator so check 6b does not also fire. `set local` ends with the transaction.
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
      assert.match(rejected.output, /columns across the prl schema, read from pg_catalog as prl_app/);
      assert.match(rejected.output, /invisible to prl_app/);

      await throwaway.sql.begin(async (tx) => {
        await tx`set local role prl_migrator`;
        await tx`drop table prl.hand_deck_cache`;
      });
      const reverted = await verify(runtimeUrl);
      assert.equal(reverted.code, 0, `after the revert the verifier should pass:\n${reverted.output}`);
    });
  });

  /**
   * Not a past bug. `information_schema.tables` happens to count TRUNCATE as visibility, so check 6 was
   * sound by coincidence. This pins the finding after the switch to `pg_class`.
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
    // An empty catalogue has no forbidden columns, so a naive verifier would pass it.
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
