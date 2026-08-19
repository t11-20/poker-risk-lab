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
 */

import postgres from 'postgres';

const SCHEMA = 'prl';

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
  // ---- 1 & 2. Forbidden columns -------------------------------------------------------
  const columns = await sql`
    select table_name, column_name, data_type
    from information_schema.columns
    where table_schema = ${SCHEMA}
    order by table_name, ordinal_position
  `;
  note(`${columns.length} columns across the ${SCHEMA} schema`);

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
    const tables = await sql`
      select table_name from information_schema.tables
      where table_schema = ${SCHEMA} and table_type = 'BASE TABLE'
    `;
    for (const { table_name: table } of tables) {
      const [privilege] = await sql`
        select has_table_privilege('prl_app', ${`${SCHEMA}.${table}`}, 'TRUNCATE') as can_truncate
      `;
      if (privilege?.can_truncate === true) fail('prl_app', `can TRUNCATE ${table}`);
    }
    note(`checked ${tables.length} tables for prl_app privileges`);
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
