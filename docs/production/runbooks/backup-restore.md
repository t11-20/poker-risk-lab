# Backup and restore

Data is lost, wrong, or deleted — or you are rehearsing the day it is.

Read [README.md](README.md) first. The tooling, the retention policy, the encryption design and the evidence from a restore that was actually performed are in [`../backup-restore.md`](../backup-restore.md); the scenarios and what this architecture genuinely cannot recover are in [`../disaster-recovery.md`](../disaster-recovery.md). This runbook is the hour in which something has already happened.

Three things to hold before anything else:

- **PostgreSQL is the only durable state.** Containers, proxy configuration and secrets are rebuilt, not restored.
- **The RPO is 24 hours.** There is no WAL archiving, so everything written since the last archive is gone. That is a deliberate trade, not an oversight ([`../backup-restore.md`](../backup-restore.md) §5).
- **The hand in progress is not recoverable by anything.** It exists only in the API process's memory ([`../disaster-recovery.md`](../disaster-recovery.md) §6).

---

## Symptoms

- Rows a learner had are missing: progress, hand history, an account.
- A `DELETE` or an `UPDATE` ran with the wrong `WHERE`, or the account-deletion flow ran against the wrong user.
- Data is present but wrong, and has been for a while — the classic late-discovered corruption.
- The database, its volume, or its host is gone.
- `pnpm run backup verify` fails, or `backup list` shows the newest good archive is older than 24 hours.
- Nothing is wrong at all: this is the quarterly rehearsal, and it belongs here because a recovery plan nobody has executed is a hypothesis.

## Detection

**Two facts decide every branch below, and guessing at either is how a recovery makes things worse.**

**1. When did it start?** Not when it was noticed. The three sources are `prl.audit_log`, the application logs, and `schema_migrations.applied_at`. Getting this wrong by a day means restoring the corruption.

**2. Is the live database still authoritative for anything?** If learners have used the system since the damage, it holds rows that exist in no archive. **Restoring over it destroys those.**

```bash
node scripts/backup.mjs list          # what exists, how old, retention class, integrity state
node scripts/backup.mjs verify --deep # prove the archive you are about to rely on
```

Never skip the `verify --deep`. It takes seconds — 0.755 s to checksum *and* authenticate 287.8 MiB at the measured scale — and it is the difference between a recovery and an outage that gets longer.

`verify` has four layers and each supports a different sentence. Conflating them is how a backup system passes its own checks for years and then cannot restore:

| Layer | Proves | Does **not** prove |
| --- | --- | --- |
| 1 manifest HMAC | the checksums below are the ones recorded at dump time | anything about the archive itself |
| 2 sha256 of the ciphertext | the bytes did not rot | **that `pg_restore` can read them** — a dump truncated by a full disk hashes perfectly, every time |
| 3 authenticated decryption, frame by frame, to the terminator | the archive is complete, unaltered, and decrypts to exactly what `pg_dump` produced | that `pg_dump` produced a *usable* archive |
| 4 `pg_restore --list`; with `--deep`, a real restore into a scratch database | the table of contents parses; with `--deep`, that the whole thing executes | **that the application works against it** |

Layer 4 also carries the cheap detector for a dump taken the wrong way: a correct dump of this database has **16 ACL entries**; a `--no-privileges` dump has 0, and `verify` fails on it by name.

Layers 1 to 3 need no database at all, so an offsite copy can be verified on a laptop.

## Immediate containment

**Stop writing to the damaged database if the damage is ongoing.** A corrupting release is a rollback decision first: [rollback.md](rollback.md). Restoring under a process that is still writing wrong rows recovers nothing.

**Take a backup of the current state, right now, to a different location.** Whatever else is true, the live database holds rows that exist nowhere else. This is the first action in a destroyed-archives scenario and it is a good habit in every other one.

```bash
node scripts/backup.mjs create --dir "$SOMEWHERE_ELSE" --key-file "$KEY"
```

**Do not restore over the live database.** Almost always the right first move is a restore into a *scratch* database and a comparison. The tool enforces this: `backup restore` requires `--drop-existing` for a database that exists, `--overwrite-live-database` for the one `DATABASE_URL` names, and `--yes-i-am-restoring-production` on top of both when `NODE_ENV=production`. Three separate dangers, three separate acknowledgements, deliberately not collapsed into one flag — the common mistake is a fat-fingered `--target` naming your own database, and a single flag covering both hands the person who wanted the first one the second for free.

**Do not run `prune --apply`.** Retention is not urgent and deletion during an incident is unrecoverable. The shipped weekly unit runs `verify --all`, then `verify --deep`, then `prune --apply`, aborting on the first failure, precisely so automated deletion can never be the thing that finishes the job.

**Do not reach for a `down` migration.** There is none, and the schema is not what is wrong.

## Diagnosis

Which scenario is this? The full tree is [`../disaster-recovery.md`](../disaster-recovery.md) §4; the short form:

| What happened | Scenario | Shape of the answer |
| --- | --- | --- |
| A few rows gone, and you know which | §5.1 | restore to **scratch**, copy the rows back |
| A migration or a release wrote wrong data | §5.2 | roll the **application** back, restore to scratch, diff, then write the **next** migration |
| Wrong for weeks, noticed today | §5.3 | pick an archive from *before* it started; decide **per table**, not per database |
| The database is destroyed | §5.4 | roles first, then restore into a named database, then prove it |
| The host or cluster is gone | §5.5 | as §5.4, plus provisioning, DNS, TLS, images and secrets — this is why its RTO is hours |
| The archives are gone too | §5.6 | **not recoverable** |
| The key is gone | §5.7 | **not recoverable, by design** |
| A hand vanished mid-play | §6 | **not recoverable, by design** |

Two traps worth naming explicitly, because both are the most common way this goes wrong:

- **Restoring the whole database to recover three rows destroys everything written since the backup.** That is a bigger incident than the one being fixed.
- **A restore signs everybody out.** Sessions are rows. Guests are first-class accounts, so a guest created after the archive is gone entirely and cannot prove they existed. That is the single worst consequence of a restore here, and it is the reason the RPO is a day rather than a week.

## Recovery

### The one procedure everything else builds on

```bash
# 1. Roles FIRST. They are cluster-wide and are NOT in a single-database dump; without them
#    every ALTER ... OWNER and GRANT in the dump fails on a fresh cluster.
DATABASE_MIGRATION_URL="$ADMIN_URL" node apps/api/scripts/migrate.mjs roles
#    On a genuinely fresh cluster use the archive's own globals instead — they also carry the
#    login roles and their passwords, which `migrate.mjs roles` does not:
#      node scripts/backup.mjs restore --with-globals --target …

# 2. Restore into a database that does not exist yet.
node scripts/backup.mjs restore --dir "$ARCHIVES" --key-file "$KEY" \
  --target prl_recover_$(date -u +%Y%m%d)

# 3. Prove it BEFORE pointing anything at it. See Verification.
```

The restoring identity must be a member of `prl_migrator`, or a superuser: the dump contains `ALTER SCHEMA prl OWNER TO prl_migrator`, and PostgreSQL will not let a role assign ownership to a role it cannot `SET ROLE` to. `migrate.mjs roles` grants `prl_migrator` to whoever runs it, so run step 1 as the identity that will run step 2.

Never pass `--no-owner` or `--no-privileges`. `docs/RUNBOOK.md` §11.4 measured what that costs: `pg_restore` exits **0** — which is the dangerous part, it looks like success — and the resulting database has every row and every index with all 54 relations owned by `prl_api`, the runtime role, which therefore holds `CREATE` on the schema and can `DROP` every table it serves. The entire least-privilege posture, inverted, in a database that looks fine.

### Recovering specific rows (§5.1)

Restore to scratch, look before copying, then copy across **respecting foreign keys**: `users`, then `rooms` and `room_members`, then `hands`, `hand_seats`, `hand_actions`, then `lesson_progress` and the attempt tables. **Do not copy `sessions`** — a restored session row resurrects a token that was invalidated, and the learner can simply start a new one.

### Repairing wrong data (§5.2)

Roll the application back first (migrations are additive-first, so the older release runs against the newer schema), restore to scratch, diff the affected tables to establish the blast radius, then write the **next** migration. Never edit an applied one: they are checksummed and immutable, contents and filename.

A repair migration that deletes rows will hit the destructive-statement gate and be refused unless it declares `-- prl:irreversible: <reason>`. **That is the gate working.** Write the reason.

### Rehearsing

Quarterly, against a *copy* of production, to the standard in [`../backup-restore.md`](../backup-restore.md) §7 — and then update the measured RTO in [`../disaster-recovery.md`](../disaster-recovery.md) §2 with what it actually took, and note who did it and when. A rehearsal whose result nobody wrote down has produced no evidence.

## Verification

**`pg_restore` exiting 0 is not the test.** Every one of these is:

```bash
# 1. Every documented schema security property, as the RUNTIME role — so the grants are
#    actually exercised, not assumed.
DATABASE_URL="$RESTORED_RUNTIME_URL" node apps/api/scripts/verify-schema.mjs     # must exit 0

# 2. Which release this database belongs to. Note the variable: the ledger is deliberately
#    NOT readable by the runtime role.
DATABASE_MIGRATION_URL="$RESTORED_ADMIN_URL" node apps/api/scripts/migrate.mjs status

# 3. Ownership. A restore silently gets this wrong and it is the property that matters most.
psql "$RESTORED_ADMIN_URL" -c \
  "select nspname, pg_get_userbyid(nspowner) from pg_namespace where nspname='prl';"
#    must answer prl_migrator
psql "$RESTORED_ADMIN_URL" -c "select pg_get_userbyid(relowner), count(*) from pg_class c
  join pg_namespace n on n.oid=c.relnamespace where n.nspname='prl' group by 1;"
#    must be prl_migrator and nothing else

# 4. The application starts against it and BOTH probes pass. /ready is the meaningful one:
#    it queries the database.
curl -fsS "$API/api/v1/health" && curl -fsS "$API/api/v1/ready"

# 5. The row census matches the archive — `restore` compares it automatically and says so.
```

Then the half nobody checks: **the rows are back, but for whom?** A restore is not finished until authorisation still holds on restored data. [`../backup-restore.md`](../backup-restore.md) §7.8 is the pattern — nine checks including a positive control, so that a refusal cannot be a broken endpoint wearing a 404. The requirement is that a brand-new guest cannot read a *restored* room that is not theirs, sees none of the restored rooms in `GET /rooms`, inherits none of the restored learners' progress, and sees none of the restored hand history.

`verify-schema.mjs` check 6b now asserts that schema `prl` and every relation in it are owned by `prl_migrator`, so step 3 above is belt and braces rather than the only line of defence. This paragraph used to warn that `docs/RUNBOOK.md` §11.7 still carried a checklist item saying `db:verify` does not look at ownership — it no longer does: that item now says check 6b covers ownership and keeps the hand queries as belt and braces, and §11.4's own box records the fix. Run step 3 anyway — a database you cannot run the script against is exactly when you need the queries.

## Escalation

Escalate when:

- **The archives are gone as well.** Not recoverable ([`../disaster-recovery.md`](../disaster-recovery.md) §5.6). The current database is all there is; back it up elsewhere immediately, before anything else.
- **The key is lost.** Not recoverable, by design (§5.7). Every historical archive is permanently unreadable.
- **The corruption predates every archive.** Say so plainly, write down what was affected, and fix forward.
- **Restoring would reinstate deleted accounts.** This is a genuine conflict and it needs a data owner, not an on-call engineer: a restore brings back rows that an erasure request deliberately removed, which directly contradicts the commitment made to that learner. [account-deletion-failure.md](account-deletion-failure.md) names the conflict and refers it onward. Whoever decides must decide **both** halves — whether to restore, and how the erasure is re-applied afterwards — and the re-application must go through the same code path the deletion flow uses, not a hand-written `DELETE`.
- **The RPO or RTO in [`../backup-restore.md`](../backup-restore.md) §5 will be missed.** Those numbers are only meaningful if somebody is told when they are not met.
- **A restore is being considered over the live production database.** Two people, minimum. The three flags exist to make this deliberate; they do not make it safe.

Attach: the archive id and its `verify` output, `backup list`, the timeline from §Detection, the row census comparison, and the output of every command in §Verification.
