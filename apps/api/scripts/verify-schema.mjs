#!/usr/bin/env node
/**
 * `pnpm run db:verify`. Checks the live schema against the threat model's claims.
 * 1-2 no deck, salt or raw secret columns. 3-4 idempotency and seating indexes. 5 invite_only.
 * 6 prl_app least privilege, 6b migrator ownership. 7 no score columns. 8 bot_profile matches
 * @prl/poker-ai. 9 users foreign-key delete actions. 10 the exact prl_app grant matrix.
 * Every check reads `pg_catalog`. `information_schema` is filtered by the connecting role's
 * privileges, so it cannot see the tables nobody granted.
 */

import { PROFILES } from '@prl/poker-ai';
import postgres from 'postgres';

const SCHEMA = 'prl';

// Mirrors src/rooms/bot-profile.ts.
const PERSISTABLE_BOT_PROFILES = [...PROFILES.map((profile) => profile.naming.id), 'unknown'];

const DELETE_ACTIONS = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

/**
 * The account-deletion policy, written out because a list read from the database cannot detect a
 * change to it. An unlisted key fails too. A bare `REFERENCES prl.users (id)` defaults to NO ACTION,
 * which makes the learner undeletable.
 */
const USER_REFERENCE_ACTIONS = [
  ['sessions_user_id_fkey', 'c', 'a session is a credential for one learner and nothing else'],
  ['lesson_progress_user_id_fkey', 'c', 'what one learner has read is their record alone'],
  ['quiz_attempts_user_id_fkey', 'c', 'an attempt is that learner answering, and nobody else'],
  ['scenario_attempts_user_id_fkey', 'c', 'as quiz_attempts'],
  [
    'room_members_user_id_fkey',
    'c',
    'a seat describes one learner. RESTRICT here, with no predicate for left_at, made a membership ' +
      'the learner ended months ago block their deletion as hard as a live one',
  ],
  [
    'hand_seats_user_id_fkey',
    'n',
    'the hand belongs to everybody who was in it. The seat survives with its identity detached; ' +
      'CASCADE here would delete the record other players hold of a hand they played',
  ],
  [
    'audit_log_user_id_fkey',
    'n',
    'the security event happened. Deleting the row would let an account erase its own audit trail',
  ],
  [
    'rooms_owner_user_id_fkey',
    'n',
    'a room cascades to its hands, so CASCADE here would destroy the hand history of everybody ' +
      'who ever played at that table; RESTRICT made every learner who had created one undeletable',
  ],
  [
    'enrolments_user_id_fkey',
    'c',
    'an enrolment describes one person in one cohort and nobody else, so it goes with the account ' +
      'exactly as a room membership does. The RECORD that the grant and the revocation happened ' +
      'survives in prl.audit_log with user_id NULL, which is where an operator can still answer ' +
      '"on what authority, against which reference" about an account that has been erased ' +
      '(db/migrations/0006_cohort_enrolments.sql; legal register 3.1)',
  ],
];

// `REFERENCES` and `TRIGGER` are included because both are on 0001's never-granted list.
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/**
 * The grant matrix from `db/migrations/0001_initial.sql`, written out for the same reason as
 * `USER_REFERENCE_ACTIONS`. A new table grants prl_app nothing by default, so a forgotten GRANT
 * shows up only as a runtime `permission denied`. An over-grant is just as much a failure, and so
 * is an unlisted table.
 */
const APP_TABLE_GRANTS = [
  ['users', 'SELECT INSERT UPDATE DELETE', 'sign-up, rename, guest sweep, and a learner leaving'],
  ['sessions', 'SELECT INSERT UPDATE DELETE', 'login, refresh, revoke, expiry sweep'],
  ['oidc_login_attempts', 'SELECT INSERT UPDATE DELETE', 'start, single-use consume, sweep'],
  ['lesson_progress', 'SELECT INSERT UPDATE DELETE', 'a learner may clear their own progress'],
  ['rooms', 'SELECT INSERT UPDATE', 'create, play, close. No DELETE: closing is a status change'],
  ['room_members', 'SELECT INSERT UPDATE', 'join, re-seat, leave. Removal happens by CASCADE (0004)'],
  ['hands', 'SELECT INSERT UPDATE', 'deal, advance, settle. A hand is history and is never deleted'],
  ['hand_seats', 'SELECT INSERT UPDATE', 'deal, show down, settle. As hands'],
  ['hand_actions', 'SELECT INSERT', 'append-only: the ledger of what was done in a hand'],
  ['quiz_attempts', 'SELECT INSERT', 'append-only'],
  ['scenario_attempts', 'SELECT INSERT', 'append-only'],
  ['audit_log', 'SELECT INSERT', 'append-only; a role that can edit the audit log has no audit log'],
  [
    'room_ownership',
    'SELECT INSERT UPDATE DELETE',
    'the room lease (migration 0005). DELETE is the odd one and is argued in that file: a lease row ' +
      'is a statement about the present rather than history, and releasing it by deleting it is what ' +
      'lets a deploy hand a room over at once instead of stranding it for a whole lease TTL',
  ],
  [
    'cohorts',
    'SELECT',
    'the class list (migration 0006). Read-only for the request path: an entitlement check has to ' +
      'join it, and nothing a learner can reach may create or re-date a cohort',
  ],
  [
    'enrolments',
    'SELECT',
    'who is entitled and until when (migration 0006). The NARROWEST grant in this schema, and ' +
      'deliberately narrower than the append-only ledgers: the request path must be able to ask ' +
      'whether somebody is entitled and must not be able to enrol anybody, extend its own access ' +
      'or erase a revocation. Grant and revoke run from apps/api/scripts/enrolments.mjs as the ' +
      'migrating identity, which no HTTP handler can reach',
  ],
  [
    'schema_migrations',
    'SELECT',
    'read-only, since migration 0010: the API compares the ledger with the migrations it shipped and ' +
      'refuses to boot against a schema behind them (apps/api/src/schema-guard.ts), because an API ' +
      'that booted green against a missing column lost archive writes in silence. 0001 granted ' +
      'nothing here; never a write, or the request path could mark a migration applied that is not',
  ],
];

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set. Run `pnpm run db:setup` first.');
  process.exit(1);
}

const sql = postgres(url, {
  max: 1,
  connect_timeout: 10,
  idle_timeout: 2,
  // postgres.js writes notices to stdout, in the middle of the findings.
  onnotice: () => undefined,
});

const failures = [];
const notes = [];
const fail = (check, detail) => failures.push(`${check}: ${detail}`);
const note = (text) => notes.push(text);

try {
  // Printed with the counts so transcripts from two identities can be compared.
  const [identity] = await sql`select current_user as role`;
  const role = identity?.role ?? 'unknown';

  // 1 and 2. Do not switch this to `information_schema.columns`: it hides tables the role has no
  // grant on. `relkind` also covers materialized views.
  // The domain is unwrapped one level, so `prl.sha256_hash` reads as bytea.
  const columns = await sql`
    select cls.relname as table_name,
           att.attname as column_name,
           format_type(
             case when typ.typtype = 'd' then typ.typbasetype else att.atttypid end,
             case when typ.typtype = 'd' then typ.typtypmod else att.atttypmod end
           ) as data_type
    from pg_catalog.pg_attribute att
    join pg_catalog.pg_class cls on cls.oid = att.attrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
    join pg_catalog.pg_type typ on typ.oid = att.atttypid
    where nsp.nspname = ${SCHEMA}
      and cls.relkind in ('r', 'p', 'v', 'm', 'f')
      and att.attnum > 0
      and not att.attisdropped
    order by cls.relname, att.attnum
  `;
  note(`${columns.length} columns across the ${SCHEMA} schema, read from pg_catalog as ${role}`);

  // A note, never a failure. It reports what `information_schema` would have missed, and is 0 when
  // grants are correct.
  const [visible] = await sql`
    select count(*)::int as count from information_schema.columns where table_schema = ${SCHEMA}
  `;
  const hidden = columns.length - (visible?.count ?? 0);
  if (hidden > 0) {
    note(`${hidden} of them are invisible to ${role}; information_schema would not have checked those`);
  }

  // Matched on the column name, and deliberately broad.
  const forbidden = [
    { re: /(^|_)deck(_|$)/i, why: 'would persist deck order — undealt cards become readable' },
    { re: /salt/i, why: 'would persist commitment salts — sealed Merkle leaves become brute-forceable' },
    { re: /(^|_)(session_)?token$/i, why: 'a raw session token must never be stored, only its hash' },
    { re: /invite_code$/i, why: 'a raw invite code must never be stored, only its hash' },
    { re: /(^|_)ip(_address)?$/i, why: 'a raw IP must never be stored, only a keyed hash' },
    { re: /user_agent$/i, why: 'a raw user agent must never be stored, only a keyed hash' },
  ];
  for (const column of columns) {
    for (const { re, why } of forbidden) {
      if (re.test(column.column_name)) {
        fail('forbidden column', `${column.table_name}.${column.column_name} — ${why}`);
      }
    }
  }

  const requiredHashes = [
    ['sessions', 'token_hash'],
    ['rooms', 'invite_code_hash'],
  ];
  for (const [table, column] of requiredHashes) {
    const found = columns.find((c) => c.table_name === table && c.column_name === column);
    if (found === undefined) fail('missing hash column', `${table}.${column} does not exist`);
    else if (found.data_type !== 'bytea') {
      fail('wrong hash type', `${table}.${column} is ${found.data_type}, expected bytea`);
    }
  }

  // 3 and 4.
  const indexes = await sql`
    select tablename, indexname, indexdef
    from pg_indexes
    where schemaname = ${SCHEMA}
  `;
  note(`${indexes.length} indexes`);

  const hasPartialUnique = (table, columnsText) =>
    indexes.some(
      (index) =>
        index.tablename === table &&
        /UNIQUE/i.test(index.indexdef) &&
        columnsText.every((needle) => index.indexdef.includes(needle)) &&
        /WHERE/i.test(index.indexdef),
    );
  const hasUnique = (table, columnsText) =>
    indexes.some(
      (index) =>
        index.tablename === table &&
        /UNIQUE/i.test(index.indexdef) &&
        columnsText.every((needle) => index.indexdef.includes(needle)),
    );

  if (!hasPartialUnique('hand_actions', ['hand_id', 'action_id'])) {
    fail(
      'missing idempotency index',
      'no PARTIAL UNIQUE index on hand_actions (hand_id, action_id). Without it, a retried ' +
        'action can be applied twice under concurrent requests — application-level dedup is ' +
        'not sufficient.',
    );
  }
  if (!hasUnique('hand_actions', ['hand_id', 'sequence'])) {
    fail('missing sequence index', 'no UNIQUE index on hand_actions (hand_id, sequence)');
  }
  if (!hasPartialUnique('room_members', ['room_id', 'seat'])) {
    fail('missing seating index', 'no partial UNIQUE index on room_members (room_id, seat)');
  }
  if (!hasPartialUnique('room_members', ['room_id', 'user_id'])) {
    fail('missing membership index', 'no partial UNIQUE index on room_members (room_id, user_id)');
  }
  if (!hasUnique('hands', ['room_id', 'hand_number'])) {
    fail('missing hand-number index', 'no UNIQUE index on hands (room_id, hand_number)');
  }

  // 5.
  const checks = await sql`
    select rel.relname as table_name, con.conname, pg_get_constraintdef(con.oid) as definition
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = ${SCHEMA} and con.contype = 'c'
  `;
  const visibility = checks.filter((c) => c.table_name === 'rooms' && /visibility/i.test(c.definition));
  if (visibility.length === 0) {
    fail(
      'missing visibility constraint',
      'rooms.visibility has no CHECK constraint. ADR 0010 puts it in the schema on purpose, so ' +
        'that shipping public matchmaking needs a migration and therefore a review.',
    );
  } else {
    const definition = visibility.map((c) => c.definition).join(' ');
    if (!/invite_only/.test(definition)) {
      fail('visibility constraint', `does not mention invite_only: ${definition}`);
    }
    const quoted = [...definition.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const distinct = [...new Set(quoted)];
    if (distinct.length > 1) {
      fail('visibility constraint', `permits more than invite_only: ${distinct.join(', ')}`);
    }
  }

  // 8. A drift here stores the unlisted Legends as `unknown`.
  // `pg_get_constraintdef` renders `IN (...)` as `= ANY (ARRAY['x'::text, ...])`, so match the literals.
  const botProfileChecks = checks.filter(
    (c) =>
      c.table_name === 'room_members' &&
      /\bbot_profile\b/i.test(c.definition) &&
      /'[a-z0-9-]+'::text/.test(c.definition),
  );
  if (botProfileChecks.length === 0) {
    fail(
      'missing bot_profile constraint',
      'room_members.bot_profile has no value CHECK. Without one the column can hold any string, ' +
        'and a seat that names a profile no build carries cannot be refused at write time.',
    );
  } else {
    const definition = botProfileChecks.map((c) => c.definition).join(' ');
    const permitted = new Set([...definition.matchAll(/'([a-z0-9-]+)'::text/g)].map((m) => m[1]));
    const expected = new Set(PERSISTABLE_BOT_PROFILES);
    const missing = [...expected].filter((value) => !permitted.has(value));
    const extra = [...permitted].filter((value) => !expected.has(value));
    if (missing.length > 0) {
      fail(
        'bot_profile constraint',
        `does not permit ${missing.join(', ')} — a seat with that profile cannot be persisted, so a ` +
          'restart would forget which opponent the learner chose',
      );
    }
    if (extra.length > 0) {
      fail(
        'bot_profile constraint',
        `permits ${extra.join(', ')}, which @prl/poker-ai does not carry — a row naming one could ` +
          'never be rehydrated',
      );
    }
    if (missing.length === 0 && extra.length === 0) {
      note(`bot_profile permits exactly the ${expected.size} runtime values`);
    }
  }

  // 9. Read from `pg_constraint`, because a restore or hotfix can differ from the migration text.
  const userReferences = await sql`
    select con.conname, rel.relname as on_table, con.confdeltype
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_class referenced on referenced.oid = con.confrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = ${SCHEMA} and con.contype = 'f' and referenced.relname = 'users'
    order by rel.relname
  `;
  if (userReferences.length === 0) {
    fail(
      'user references',
      'no foreign key references prl.users at all. Either the schema is not migrated or the ' +
        'account-deletion policy has nothing left to hold, and neither is a database this check ' +
        'can pass over in silence.',
    );
  } else {
    const found = new Map(userReferences.map((row) => [row.conname, row]));
    for (const [name, expected, why] of USER_REFERENCE_ACTIONS) {
      const row = found.get(name);
      found.delete(name);
      if (row === undefined) {
        fail('user reference', `${name} does not exist, so the rule it carried is not enforced: ${why}`);
        continue;
      }
      if (row.confdeltype !== expected) {
        fail(
          'user reference',
          `${row.on_table}: ${name} is ON DELETE ${DELETE_ACTIONS[row.confdeltype] ?? row.confdeltype}, ` +
            `expected ${DELETE_ACTIONS[expected]} — ${why}`,
        );
      }
    }
    for (const row of found.values()) {
      fail(
        'user reference',
        `${row.on_table}.${row.conname} references prl.users and is not in the account-deletion ` +
          `policy (it is ON DELETE ${DELETE_ACTIONS[row.confdeltype] ?? row.confdeltype}). Decide what ` +
          'an erasure does to that table, write it into the policy, and add it to ' +
          'USER_REFERENCE_ACTIONS in this script.',
      );
    }
    note(`checked the delete action of ${userReferences.length} foreign key(s) referencing users`);
  }

  // 6.
  const roles = await sql`select rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles`;
  const appRole = roles.find((role) => role.rolname === 'prl_app');
  if (appRole === undefined) {
    fail('missing role', 'prl_app does not exist — the runtime role is what bounds an injection');
  } else {
    if (appRole.rolsuper) fail('prl_app', 'is a superuser');
    if (appRole.rolcreatedb) fail('prl_app', 'can create databases');
    if (appRole.rolcreaterole) fail('prl_app', 'can create roles');

    const [schemaCreate] = await sql`
      select has_schema_privilege('prl_app', ${SCHEMA}, 'CREATE') as can_create,
             has_schema_privilege('prl_app', ${SCHEMA}, 'USAGE')  as can_use
    `;
    if (schemaCreate?.can_create === true) {
      fail('prl_app', `holds CREATE on schema ${SCHEMA} — it should have DML only`);
    }
    if (schemaCreate?.can_use !== true) {
      fail('prl_app', `lacks USAGE on schema ${SCHEMA}, so the app cannot read anything`);
    }

    const owned = await sql`
      select rel.relname
      from pg_class rel
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      join pg_roles owner on owner.oid = rel.relowner
      where nsp.nspname = ${SCHEMA} and owner.rolname = 'prl_app'
    `;
    if (owned.length > 0) {
      fail(
        'prl_app',
        `owns ${owned.length} relation(s), so it can DROP them: ${owned.map((r) => r.relname).join(', ')}`,
      );
    }

    // TRUNCATE is separate from DELETE and bypasses row-level rules. Tables come from `pg_class`.
    const tables = await sql`
      select cls.relname as table_name
      from pg_catalog.pg_class cls
      join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
      where nsp.nspname = ${SCHEMA} and cls.relkind in ('r', 'p')
      order by cls.relname
    `;
    for (const { table_name: table } of tables) {
      const [privilege] = await sql`
        select has_table_privilege('prl_app', ${`${SCHEMA}.${table}`}, 'TRUNCATE') as can_truncate
      `;
      if (privilege?.can_truncate === true) fail('prl_app', `can TRUNCATE ${table}`);
    }
    note(`checked ${tables.length} tables for prl_app privileges, run as ${role}`);
  }

  // 6b. A restore as `prl_api` without `--exit-on-error` leaves every relation owned by prl_api,
  // which check 6 does not catch. RUNBOOK §11.4 uses `db:verify` as the restore rehearsal.
  {
    const [schemaOwner] = await sql`
      select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${SCHEMA}
    `;
    if (schemaOwner !== undefined && schemaOwner.owner !== 'prl_migrator') {
      fail(
        'schema ownership',
        `schema ${SCHEMA} is owned by ${schemaOwner.owner}, not prl_migrator — an owner holds ` +
          'CREATE and can DROP; this is what a restore without --exit-on-error leaves behind',
      );
    }

    const misowned = await sql`
      select c.relname, pg_get_userbyid(c.relowner) as owner
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${SCHEMA}
        and c.relkind in ('r', 'v', 'm', 'S', 'p')
        and pg_get_userbyid(c.relowner) <> 'prl_migrator'
      order by c.relname
    `;
    if (misowned.length > 0) {
      const shown = misowned
        .slice(0, 5)
        .map((r) => `${r.relname} (${r.owner})`)
        .join(', ');
      fail(
        'relation ownership',
        `${misowned.length} relation(s) in ${SCHEMA} are not owned by prl_migrator: ${shown}` +
          (misowned.length > 5 ? ', …' : ''),
      );
    }
    note(`checked schema and ${misowned.length === 0 ? 'every' : 'each'} relation owner`);
  }

  // 10. `has_table_privilege`, not `relacl`, because the ACL array misses privileges inherited
  // through membership.
  {
    const before = failures.length;
    const declared = new Map(APP_TABLE_GRANTS.map(([table, verbs, why]) => [table, { verbs, why }]));
    const present = await sql`
      select cls.relname as table_name
      from pg_catalog.pg_class cls
      join pg_catalog.pg_namespace nsp on nsp.oid = cls.relnamespace
      where nsp.nspname = ${SCHEMA} and cls.relkind in ('r', 'p')
      order by cls.relname
    `;
    for (const { table_name: table } of present) {
      const [held] = await sql`
        select coalesce(
          string_agg(privilege, ' ' order by ordinality),
          ''
        ) as verbs
        from unnest(${TABLE_PRIVILEGES}::text[]) with ordinality as candidate(privilege, ordinality)
        where has_table_privilege('prl_app', ${`${SCHEMA}.${table}`}, candidate.privilege)
      `;
      const actual = held?.verbs ?? '';
      const expectation = declared.get(table);
      declared.delete(table);
      if (expectation === undefined) {
        fail(
          'grant matrix',
          `${table} is not in APP_TABLE_GRANTS, so nobody has decided what prl_app may do to it ` +
            `(it currently holds: ${actual === '' ? 'nothing' : actual}). Decide, write it into the ` +
            'migration that created the table, and add it to that list in this script.',
        );
        continue;
      }
      if (actual !== expectation.verbs) {
        fail(
          'grant matrix',
          `prl_app holds ${actual === '' ? 'nothing' : actual} on ${table}, expected ` +
            `${expectation.verbs === '' ? 'nothing' : expectation.verbs} — ${expectation.why}`,
        );
      }
    }
    for (const [table, expectation] of declared) {
      fail(
        'grant matrix',
        `${table} is in APP_TABLE_GRANTS and does not exist in the schema (${expectation.why}). ` +
          'Either the database is not migrated or a table was removed and the matrix was not.',
      );
    }
    if (failures.length === before) {
      note(`prl_app holds exactly the declared verbs on all ${present.length} tables`);
    }
  }

  // 7. Whole words only. A bare /level/ flagged the poker column `hand_actions.bet_level_after`.
  const gamificationWords =
    /^(?:score|total_score|grade|streak|current_streak|best_streak|level|user_level|rank|ranking|xp|experience_points|points|achievement|badge)$/i;
  const scoreColumns = columns.filter((c) => gamificationWords.test(c.column_name));
  if (scoreColumns.length > 0) {
    fail(
      'gamification column',
      `${scoreColumns.map((c) => `${c.table_name}.${c.column_name}`).join(', ')} — ` +
        'PRODUCT-GUARDRAILS §2 forbids scores, streaks, levels and ranks; there is deliberately ' +
        'nowhere to store one',
    );
  }
} catch (error) {
  fail('script', error instanceof Error ? error.message : String(error));
} finally {
  await sql.end({ timeout: 5 });
}

const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

console.log('\nschema verification');
for (const text of notes) console.log(`${DIM}  · ${text}${RESET}`);
if (failures.length === 0) {
  console.log(`${GREEN}  ✓ every documented schema security property holds${RESET}\n`);
  process.exit(0);
}
for (const text of failures) console.log(`${RED}  ✗ ${text}${RESET}`);
console.log(`${RED}\n${failures.length} schema property/properties violated${RESET}\n`);
process.exit(1);
