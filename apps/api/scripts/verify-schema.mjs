#!/usr/bin/env node
/**
 * Verifies the LIVE database schema against the security properties the threat model claims.
 *
 * The migrations assert these properties in SQL comments, and the docs assert them in prose.
 * Neither is evidence. This script asks the actual database, so a migration that drifts from
 * the documented design fails a check rather than quietly disagreeing with it.
 *
 * Run against a migrated development database:
 *
 *     pnpm run db:verify
 *
 * Every check maps to a specific claim:
 *
 *   1. No column anywhere stores the deck or the commitment salts. This is the single most
 *      important persistence property: with no such column, a database read — a backup, a
 *      replica, an injection that reaches SELECT — cannot expose the undealt cards of a live
 *      hand or the unshown holdings of a finished one. (THREAT-MODEL §3)
 *   2. No column stores a raw session token, invite code, IP or user agent — only hashes.
 *   3. The partial unique index on (hand_id, action_id) exists. It is the DATABASE-level
 *      idempotency guarantee, which is what makes a retried action safe under CONCURRENT
 *      requests rather than only sequential ones. (THREAT-MODEL T4)
 *   4. The partial unique indexes on room seating exist, so two players cannot occupy one seat.
 *   5. rooms.visibility is CHECK-constrained to 'invite_only' and nothing else, so shipping
 *      public matchmaking requires a migration and therefore a review. (ADR 0010)
 *   6. The least-privilege runtime role exists and genuinely lacks CREATE/DROP/TRUNCATE.
 *   7. No aggregate quiz score column exists — quizzes must not be able to gate progress.
 *      (PRODUCT-GUARDRAILS §2)
 *   8. room_members.bot_profile accepts EXACTLY the strategy profile ids @prl/poker-ai carries,
 *      plus the pre-0003 'unknown' marker. The schema and the runtime drifting apart here is what
 *      made seven of the twelve AI Legends unrecoverable across a restart.
 *   9. Every foreign key that references prl.users carries EXACTLY the referential action the
 *      account-deletion policy depends on. This is the check migration 0004 needed and did not
 *      have: two of these keys were ON DELETE RESTRICT, which made every learner who had ever
 *      created or joined a table permanently undeletable, and nothing anywhere compared the
 *      schema's answer to the policy's requirement.
 *  10. Every table in the schema holds EXACTLY the verbs the grant matrix in
 *      db/migrations/0001_initial.sql says it holds, for prl_app, and no table exists that the
 *      matrix has not decided about. Check 6 asks whether prl_app can do the one thing that is
 *      never acceptable (TRUNCATE); this asks whether it can do precisely the things it should,
 *      which is a different and stricter question in both directions — an UPDATE on an
 *      append-only ledger and a MISSING grant on a new table are both failures, and neither was
 *      visible before.
 *
 * Every one of them reads `pg_catalog` directly, and no check reads `information_schema` at all.
 * That is a correctness requirement, not a preference: `information_schema` is filtered by the
 * connecting role's privileges, and a gate that cannot see a table cannot fail on it. The long
 * comment above the column query has the incident. The single remaining `information_schema`
 * query in this file measures the size of that filter and prints it as a note.
 */

import { PROFILES } from '@prl/poker-ai';
import postgres from 'postgres';

const SCHEMA = 'prl';

/**
 * Every value `room_members.bot_profile` must accept, derived from the runtime profile list.
 *
 * Mirrors `PERSISTABLE_BOT_PROFILES` in src/rooms/bot-profile.ts. Recomputed here rather than
 * imported because this script is plain `.mjs` run by node with no TypeScript loader, and a
 * second derivation from the same source is still a derivation — neither copy can be edited into
 * agreement with a stale schema.
 */
const PERSISTABLE_BOT_PROFILES = [...PROFILES.map((profile) => profile.naming.id), 'unknown'];

/**
 * `pg_constraint.confdeltype`, spelled out. A one-letter catalogue code in a failure message is a
 * puzzle rather than a finding.
 */
const DELETE_ACTIONS = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

/**
 * What every foreign key referencing `prl.users` must do when an account is deleted, and why.
 *
 * This table IS the account-deletion policy, restated where the database can be asked about it.
 * Written out by constraint name rather than derived, for the reason every list in this script is
 * written out: a list read from the thing it is checking cannot detect a change to it.
 *
 * A key that is absent here fails as loudly as one with the wrong action, and deliberately so. A
 * ninth foreign key added by a later migration is a table nobody has decided about; if it defaults
 * to NO ACTION (which is what `REFERENCES prl.users (id)` with no clause means) it silently
 * reinstates exactly the defect 0004 removed - a learner who cannot leave - and the failure would
 * surface as an unexplained 23503 on their deletion attempt rather than here.
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
];

/**
 * The verbs checked for every table, in the order a failure message prints them.
 *
 * All seven, not just the four DML ones. `REFERENCES` lets a role attach a foreign key to a table
 * it does not own — which is how a row becomes undeletable by somebody else's constraint — and
 * `TRIGGER` lets it attach code that runs inside another role's transaction. Both are in 0001's
 * "never granted, and must never be granted" list, and neither was checked anywhere until this
 * matrix existed.
 */
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/**
 * What `prl_app` may do to each table, and why — the grant matrix from
 * `db/migrations/0001_initial.sql`, restated where the database can be asked about it.
 *
 * ## Why this is written out rather than derived
 *
 * For the same reason `USER_REFERENCE_ACTIONS` is: a list read from the thing it is checking cannot
 * detect a change to it. Deriving the expectation from the live ACL would make this check assert
 * that the database agrees with itself.
 *
 * ## The failure it exists for, which is the default rather than the exception
 *
 * 0001 says in as many words that PostgreSQL's built-in default for a new table is owner-only, "so
 * a table added by a later migration grants prl_app nothing at all until that migration says so".
 * That is the right default and it makes a forgotten GRANT invisible: the migration applies, the
 * schema is correct, `db:verify` passes, and the first anybody hears of it is a runtime
 * `permission denied` on whatever path the new table serves. `prl.room_ownership` (migration 0005)
 * is a table whose whole job is to REFUSE to serve a room it cannot read a lease for, so a missing
 * grant there would have turned a correctness guard into a total refusal of every room, at runtime,
 * with nothing in this gate to say why.
 *
 * The other direction matters just as much and is quieter. An over-grant — DELETE on `prl.hands`,
 * UPDATE on `prl.audit_log` — is a capability nobody decided to hand the request path, it looks
 * like nothing in a diff of a migration, and it is exactly what an injection reaching the runtime
 * role is bounded by.
 *
 * A table that is not in this list fails as loudly as one with the wrong verbs, and deliberately:
 * it is a table whose privileges nobody has reasoned about.
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
    'schema_migrations',
    '',
    'nothing at all, on purpose: the runtime has no business reading, let alone editing, the ' +
      'migration ledger',
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
  // Deliberately dropped rather than printed. A notice ("index already exists") is never
  // load-bearing here, and postgres.js writes them straight to stdout, which would put them in the
  // middle of this script's own findings.
  onnotice: () => undefined,
});

const failures = [];
const notes = [];
const fail = (check, detail) => failures.push(`${check}: ${detail}`);
const note = (text) => notes.push(text);

try {
  /**
   * Who this run connected as, printed with the counts below.
   *
   * Two captured transcripts of this script, taken from two different identities, were once read
   * as evidence that a restored database had lost a table. Neither number was wrong; neither said
   * which role produced it. Printing the role makes two transcripts comparable — and now that
   * nothing below reads a privilege-filtered catalogue (see the next comment), two transcripts
   * that disagree about a count describe two genuinely different databases.
   */
  const [identity] = await sql`select current_user as role`;
  const role = identity?.role ?? 'unknown';

  // ---- 1 & 2. Forbidden columns -------------------------------------------------------
  //
  // ##########################################################################
  // ## READ THE COLUMNS FROM pg_catalog. `information_schema` CANNOT SEE A  ##
  // ## TABLE THE CONNECTING ROLE HAS NO GRANT ON, AND THAT MADE CHECKS 1,   ##
  // ## 2 AND 7 BLIND TO EXACTLY THE TABLES THEY MOST NEEDED TO SEE.         ##
  // ##########################################################################
  //
  // `information_schema.columns` is FILTERED BY PRIVILEGE — its view definition ends in
  // `pg_has_role(c.relowner, 'USAGE') OR has_column_privilege(...)` — so a table the current role
  // may not touch contributes ZERO ROWS and cannot fail a check that iterates them.
  //
  // That is the default state of a new table here, not an exotic one. `pnpm run db:verify`
  // connects as `DATABASE_URL`, which RUNBOOK §5 makes `prl_api` (a member of `prl_app` and
  // nothing else), and `db/migrations/0001_initial.sql` says in as many words that a table added
  // by a later migration gets NO grant until somebody writes one. So a new table is invisible to
  // this script until a GRANT makes it visible, which is backwards: the tables nobody has decided
  // the grants for are the ones least likely to have been reviewed at all.
  //
  // Demonstrated, not theorised. `prl.hand_deck_cache (deck jsonb, deck_salts jsonb,
  // total_score int)` created by the migrator with no grants: exit 0 as `prl_api`, four
  // violations as the owner. The same database, and check 1 — this script's single most
  // important persistence property, that no column may hold the deck or the salts — answering
  // "fine" for the one table in the schema that held both.
  //
  // The asymmetry survived review for as long as it did because every OTHER check in this file
  // already reads an unfiltered catalogue: `pg_indexes` (3, 4), `pg_constraint` (5, 8, 9),
  // `pg_class`/`pg_namespace` (6b), `pg_roles` (6). Nothing in the file's shape suggested that
  // one of the reads was answering a different question from the rest.
  //
  // DO NOT "simplify" this back to `information_schema.columns` because that is shorter, or
  // because `data_type` reads more nicely than `format_type`. The privilege filter is the entire
  // bug. `pg_attribute` has none, `relkind` here also covers the materialized view that
  // `information_schema` omits altogether (a matview caching the deck is the same leak with a
  // different relkind), and `attnum > 0 and not attisdropped` is what drops the system columns
  // and the tombstones of dropped ones.
  //
  // The one thing `information_schema` did for free and this query has to do explicitly: unwrap
  // the DOMAIN. `sessions.token_hash` is `prl.sha256_hash`, a domain over `bytea` with a length
  // CHECK, and `format_type` on the column's own type answers `prl.sha256_hash` — which would
  // fail the "hash columns are bytea" check below on a perfectly correct schema. `typtype = 'd'`
  // is the domain case and `typbasetype` is what it is a domain over. One level, because every
  // domain in `0001_initial.sql` is one level over a base type and a domain over a domain would
  // be a schema decision worth failing on rather than resolving silently.
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

  // How much this run would have missed had it kept reading `information_schema`. Not a failure:
  // a runtime role that cannot see `prl.schema_migrations` is the privilege model working, and on
  // a correctly granted database this note reports the three columns of that one table. It is
  // here so the number above can never quietly become the smaller number again without somebody
  // noticing that the gap moved.
  const [visible] = await sql`
    select count(*)::int as count from information_schema.columns where table_schema = ${SCHEMA}
  `;
  const hidden = columns.length - (visible?.count ?? 0);
  if (hidden > 0) {
    note(`${hidden} of them are invisible to ${role}; information_schema would not have checked those`);
  }

  // A deck or a salt must not be storable. Matched on the column NAME, because that is what a
  // future maintainer would reach for, and deliberately broad.
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

  // The hashed counterparts must exist and be bytea, otherwise "we only store hashes" is not
  // actually implemented anywhere.
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

  // ---- 3 & 4. The indexes the concurrency guarantees rest on ---------------------------
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

  // ---- 5. visibility is constrained to invite_only ------------------------------------
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
    // Any second permitted value defeats the point of the constraint.
    const quoted = [...definition.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const distinct = [...new Set(quoted)];
    if (distinct.length > 1) {
      fail('visibility constraint', `permits more than invite_only: ${distinct.join(', ')}`);
    }
  }

  // ---- 8. The bot-seat vocabulary cannot drift from the runtime one --------------------
  //
  // This is the check the original defect needed and did not have. `room_members.bot_profile`
  // was CHECK-constrained to five values that were never the strategy profile set, and nothing
  // compared the two, so seven of the twelve Legends were silently written as `unknown` for as
  // long as the mismatch went unnoticed. Comparing the live constraint against `PROFILES` makes
  // adding or retiring a profile without a migration a failed gate rather than a lost identity.
  // `pg_get_constraintdef` renders `IN (...)` as `= ANY (ARRAY['x'::text, ...])`, so the value
  // list is matched by the quoted literals rather than by the source syntax.
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

  // ---- 9. What happens to everything an account points at, when the account goes --------
  //
  // Asked of `pg_constraint` rather than of the migration text, because the migration is a claim
  // and the catalogue is the fact. A restored dump, a hand-applied hotfix or a later migration
  // that re-created one of these keys without its clause would all leave the prose in
  // db/migrations/0004_account_deletion.sql saying one thing and the database doing another.
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

  // ---- 6. Least privilege --------------------------------------------------------------
  const roles = await sql`select rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles`;
  const appRole = roles.find((role) => role.rolname === 'prl_app');
  if (appRole === undefined) {
    fail('missing role', 'prl_app does not exist — the runtime role is what bounds an injection');
  } else {
    if (appRole.rolsuper) fail('prl_app', 'is a superuser');
    if (appRole.rolcreatedb) fail('prl_app', 'can create databases');
    if (appRole.rolcreaterole) fail('prl_app', 'can create roles');

    // It must not own anything in the schema, and must not hold CREATE on it.
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

    // TRUNCATE is a distinct privilege from DELETE and is worth checking separately: it
    // bypasses row-level rules and cannot be rolled back as cheaply.
    //
    // The table list comes from `pg_class` for the same reason the column list above does.
    //
    // Honestly stated, because the difference matters to anyone auditing this: unlike the column
    // read, this one was not actually wrong. `information_schema.tables` counts TRUNCATE among
    // the privileges its filter tests, so a table `prl_app` could TRUNCATE was always visible to
    // it. That is soundness by coincidence — it rests on a detail of one view definition, it
    // would not survive somebody widening the check to a privilege the filter does not list, and
    // it is not a thing the next reader should have to know. Converting it leaves no CHECK in
    // this file depending on a privilege-filtered catalogue; the only `information_schema` read
    // left is the diagnostic count above, which produces a note and never a verdict.
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

  // ---- 6b. The schema and everything in it is owned by the migrator ---------------------
  //
  // Check 6 asks whether `prl_app` owns anything. It never asks *who does* — and that gap is
  // reachable by the one procedure this script exists to rehearse. Restoring a dump as `prl_api`
  // without `--exit-on-error` completes with "errors ignored on restore", leaving every relation
  // in `prl` owned by `prl_api`, which then holds CREATE on the schema. `prl_app` owns nothing in
  // that state, so check 6 is satisfied and this script exited 0 over a database whose runtime
  // role could drop the tables it serves. RUNBOOK §11.4 calls `db:verify` the restore rehearsal,
  // so the rehearsal has to be able to see it.
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

  // ---- 10. The grant matrix, exactly ---------------------------------------------------
  //
  // `has_table_privilege` rather than reading `relacl`, because the ACL array does not account for
  // privileges reaching the role through membership in another one — and `prl_app` is a privilege
  // CONTAINER whose members are the login identities, so the question that matters is what the
  // container effectively holds. `pg_class` supplies the table list for the reason every other list
  // in this file comes from `pg_catalog`: `information_schema` is filtered by the connecting role's
  // privileges, and a table this script cannot see is exactly the table whose grants nobody wrote.
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

  // ---- 7. No aggregate quiz score -----------------------------------------------------
  // Matched on whole words, not substrings. A bare /level/ flagged `hand_actions.bet_level_after`
  // — the poker bet level, which is core game state and has nothing to do with gamification.
  // A check that cries wolf on legitimate schema gets muted, so precision here is what keeps it
  // useful.
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
