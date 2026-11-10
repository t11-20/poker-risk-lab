# Failed migration

A migration step did not exit 0, or exited 0 and left the schema wrong.

Read this before touching anything: **migrations here are roll-forward only.** `apps/api/scripts/migrate.mjs` refuses `down`, deliberately. There is no "undo the migration" step in this runbook because there is no such command, and inventing one under pressure is how data is lost.

---

## Symptoms

- The migration step of a deploy exits non-zero.
- `migrate.mjs status` shows a pending migration that will not apply.
- The API refuses to start, or starts and fails on queries.
- `verify-schema.mjs` fails after a deploy that appeared to succeed.
- Queries block on locks while a migration is running → also [db-saturation.md](db-saturation.md).

## Detection

```bash
node --env-file-if-exists=.env apps/api/scripts/migrate.mjs status
node --env-file-if-exists=.env apps/api/scripts/verify-schema.mjs
```

`status` reports what is applied, what is pending, and whether a checksum disagrees. `verify-schema.mjs` asserts the *shape* — column counts, index counts, specific constraints, ownership and role privileges — so it catches the dangerous case that `status` cannot: a migration recorded as applied whose effect is not actually present.

The runner takes a **PostgreSQL advisory lock** before doing anything, so two deploys cannot migrate at once. A migration that appears to hang is often waiting for that lock, and the wait is bounded by `PRL_MIGRATE_LOCK_WAIT_MS` (default 30,000 ms; `apps/api/scripts/migrate.mjs` reads this name and no other — `migrate.mjs --help` prints it).

## Immediate containment

**Stop the deploy.** Do not let the application roll forward onto a schema it does not have. Application code and schema are versioned together, and half of each is worse than either.

**Establish which of four states you are in.** They need different actions and confusing them is the way this becomes an outage:

| State | How to tell | Danger |
| --- | --- | --- |
| Never started | `status` shows it pending, no partial effect | none — safe to retry |
| Failed and rolled back | migration is wrapped in a transaction; Postgres undid it | none — safe to retry after fixing |
| Failed and **partially applied** | some DDL is not transactional; `status` disagrees with `verify-schema.mjs` | **high** |
| Applied, effect wrong | both pass, application queries fail | high |

```sql
-- Is the runner's own record consistent with what is really there?
select version, applied_at, checksum from prl.schema_migrations order by version;

-- Is something still holding a lock?
select pid, state, now() - query_start as duration, left(query, 120)
  from pg_stat_activity
 where application_name like '%migrat%' or query ilike '%alter table%';
```

**Do not** hand-edit `prl.schema_migrations` to make the error go away. That is the single worst action available here: it makes the runner's record a lie, and every future migration is then applied against a schema nobody can describe.

**Do not** write a "down" migration. The runner refuses `down` because a down migration that drops a column destroys data that a rollback of the *application* would not have needed to destroy. The forward path is another migration.

## Diagnosis

### The runner refuses before running anything

The gate runs before any migration is applied, so a refusal means nothing has changed. The refusals are deliberate:

| Refusal | Meaning | Fix |
| --- | --- | --- |
| checksum mismatch | an already-applied migration file was edited after the fact | restore the file to what was applied; the change belongs in a NEW migration |
| irreversible DDL without a marker | the file contains a `DROP CONSTRAINT`, `DROP COLUMN` or similar without `-- prl:irreversible: <reason>` | add the marker **with a real reason**, having decided the drop is genuinely intended |
| out-of-order numbering | a file numbered below one already applied | renumber above the highest applied version |
| `down` requested | there is no down path | write a forward migration |

The whole pending set is refused together, not just the offending file. That is intentional: applying half of a set leaves a schema that matches no release.

### The migration ran and failed

```bash
MIGRATION_DEBUG=1 node --env-file-if-exists=.env apps/api/scripts/migrate.mjs status
```

Common causes:

- **Lock timeout.** `ALTER TABLE` needs an `ACCESS EXCLUSIVE` lock; a long-running query holds it off. Find the blocker (see [db-saturation.md](db-saturation.md)) rather than raising the timeout — a longer timeout means a longer stall for every learner.
- **Constraint violation on existing data.** Adding a `NOT NULL` or a `CHECK` to a table whose rows do not satisfy it. The migration is correct and the data is not; backfill first, in its own earlier migration.
- **Insufficient privilege.** Migrations run as `prl_migrator`, the runtime as `prl_app`/`prl_api`. Two roles exist precisely so the serving credential cannot alter the schema. `permission denied` means the migration is being run with the runtime credential.
- **Disk full.** An index build needs space for the whole index → [db-unavailable.md](db-unavailable.md).

### Partially applied

The dangerous state. Some statements are not transactional — `CREATE INDEX CONCURRENTLY` most notably, which is also the right way to add an index to a live table. If one fails midway it can leave an **invalid** index behind, which queries ignore while it still costs writes:

```sql
select indexrelid::regclass as index_name, indisvalid
  from pg_index
 where not indisvalid;
```

Drop an invalid index and rebuild it; do not leave it.

## Recovery

**Never started, or cleanly rolled back.** Fix the file, re-run. This is the common case and it is safe.

**Partially applied.** Work out precisely what exists and what does not — `verify-schema.mjs` plus the queries above — then write a **forward** migration that makes the schema correct from wherever it actually is. Idempotent DDL (`IF NOT EXISTS`, `IF EXISTS`) is the right tool. Only once the schema is correct is it appropriate to reconcile `prl.schema_migrations`, and that reconciliation is a reviewed change, not a live `UPDATE`.

**Applied, effect wrong.** Forward migration.

**Deploy blocked and the fix is not immediate.** Roll the application back to the previous digest → [rollback.md](rollback.md). This works only if the old code tolerates the new schema, which is what the two-release rule in `docs/RUNBOOK.md` §11.3 exists to guarantee: the additive half ships first, so old and new code can both run against the intermediate schema. **A migration that skips the additive-first step cannot be rolled back around**, and that is the reason for the rule rather than a consequence of it.

Never run a destructive statement to unblock a deploy. There is no deploy urgent enough.

## Verification

```bash
# 1. The runner and the schema agree.
node --env-file-if-exists=.env apps/api/scripts/migrate.mjs status
node --env-file-if-exists=.env apps/api/scripts/verify-schema.mjs

# 2. No invalid indexes.
psql "$DATABASE_URL" -c "select indexrelid::regclass, indisvalid from pg_index where not indisvalid"

# 3. Ownership and privileges are still right — a migration run as the wrong role
#    leaves objects the runtime role cannot use.
psql "$DATABASE_URL" -c "\dt prl.*"

# 4. The application starts and serves against it.
curl -fsS "$API/api/v1/health" && curl -fsS "$API/api/v1/ready"

# 5. Real journeys, including the paths the migration touched.
pnpm run test:smoke --strict
```

Then rehearse it somewhere that is not production:

```bash
pnpm run test:drills --only failed-migration
```

## Escalation

Escalate when:

- The schema is partially applied and you cannot establish exactly what exists. Guessing is worse than waiting for a second person.
- Data would have to be modified or dropped to make the migration apply.
- The migration is already applied in one environment and failed in another. They have diverged, and the next deploy will hit the same wall.
- `verify-schema.mjs` fails and the cause is not obvious. Serving against a schema the application does not expect risks writing wrong rows, which is worse than being down.
- Recovery would need a restore → [backup-restore.md](backup-restore.md), and note that a restore reverts *all* data to the backup point, not just the schema.
