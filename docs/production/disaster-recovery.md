# Disaster recovery

What can go wrong, what each case costs, what to do about it, and the one thing this
architecture genuinely cannot recover.

The procedure and the tooling are in
[`backup-restore.md`](./backup-restore.md); the schedule is in
[`deploy/backup/`](../../deploy/backup/README.md). This document is for the hour when
something has already happened.

---

## 1. The one-paragraph version

PostgreSQL is the only durable state. It is backed up nightly, encrypted, and verified
weekly by a restore into a scratch database. The RPO is **24 hours** — there is no WAL
archiving, so everything written since the last backup is gone. The RTO for a database
restore is **30 minutes**. Measured 2026-08-25 on the current 149.8 MiB / 944,297-row
development database: `backup restore` into a fresh cluster took **46.5 s** end to end, of which
45.2 s was decrypt plus `pg_restore`, i.e. roughly 3.3 MB/s of *encrypted* archive on loopback.
The earlier figure in this document — 1.04 s — was taken when the database held 1,000 rows and
is not a number to plan against. **A hand in progress is not durable at all and is lost
on any API restart or crash** (§6). Everything else — containers, proxy, configuration — is
rebuilt from the repository and the secret manager, not restored.

---

## 2. Recovery objectives per scenario

| # | Scenario | RPO | RTO target | Recoverable? |
| --- | --- | --- | --- | --- |
| 1 | Accidental deletion of specific rows | 24 h | 45 min | Yes |
| 2 | Bad migration or application bug wrote wrong data | 24 h | 2 h | Yes, but needs code |
| 3 | Corruption discovered late (days or weeks after) | up to 6 months back | 2-4 h | Partially — §5.3 |
| 4 | Database destroyed (volume, instance, `DROP DATABASE`) | 24 h | **30 min** | Yes |
| 5 | Total host or cluster loss | 24 h | 4 h | Yes, if the archives are off that host |
| 6 | Archives destroyed along with the database | — | — | **No** — §5.6 |
| 7 | Archive key lost | — | — | **No** — §5.7 |
| 8 | API crash or restart mid-hand | **the hand in progress** | seconds | **No, by design** — §6 |

The RTOs above are targets, not measurements, except #4 — recorded 2026-08-25 at **46.5 s**
for the 944,297-row development database, restore into a virgin `postgres:16-bookworm` through
`verify-schema.mjs` exit 0. That did NOT include starting an API and reaching `/ready`, so it is
a floor.

**Caveat added 2026-08-26, and read it before quoting the number.** `46.5`, `45.2` and `36.7`
appear nowhere in this repository except this file: `backup-restore.md` §7.9 records
`TOTAL_ms=1039` for a 10 MB database and §8 records `restore 28.75s` for a 1,260 MB synthetic
probe, and the `{SCRATCH}` directory the run wrote to no longer exists. The two also do not
reconcile — 46.5 s for 149.8 MiB is ~3.3 MiB/s where §8's larger restore managed ~10 MiB/s — so
at least one of them is not describing this pipeline. Treat 46.5 s as a datum somebody recorded,
not as evidence a reviewer can replay, and re-run it before it decides anything.

**Every RPO in this table is bounded by the same thing: the nightly schedule.** If that is not
good enough, the answer is WAL archiving (`archive_command` plus a base backup), which is a
change to the database deployment and is deliberately not implemented here. Running the timer
four times a day gives a 6-hour RPO for four times the load, which is a poor trade compared to
doing it properly.

---

## 3. Before anything else: two facts to establish

Every branch below depends on these, and guessing at either is how a recovery makes things
worse.

**1. When did it start?** Not when it was noticed. The audit log (`prl.audit_log`), the
application logs and `schema_migrations.applied_at` are the three sources. The answer decides
which archive to reach for, and getting it wrong by a day means restoring the corruption.

**2. Is the current database still authoritative for anything?** If learners have been using
the system since the damage, the live database holds rows that exist in no backup. **Restoring
over it destroys those.** Almost always the right first move is to restore into a *scratch*
database and compare, not to restore over the live one — which is why
`backup.mjs restore` requires `--overwrite-live-database` before it will target the database
`DATABASE_URL` names.

```bash
node scripts/backup.mjs list          # what exists, how old, and whether it verifies
node scripts/backup.mjs verify --deep # prove the one you are about to rely on
```

Never skip the `verify --deep`. Measured 2026-08-25: **36.7 s** for a 149.8 MiB / 944,297-row
archive on loopback, and it is linear in the size of the dump, so budget for it rather than
assuming seconds. It is the difference between a recovery and an outage that gets longer.

---

## 4. The decision tree

```
Something is wrong with the data.
│
├─ Is the database process/host still there?
│  │
│  ├─ NO ─────────────────────────────────────────────────────► §5.4 / §5.5
│  │        Is the archive directory on that host too?
│  │        ├─ YES, and it is gone with it ───────────────────► §5.6  NOT RECOVERABLE
│  │        └─ NO, archives are elsewhere ────────────────────► restore to new host
│  │
│  └─ YES
│     │
│     ├─ Is the data merely WRONG (present but incorrect)?
│     │  ├─ Caused by a migration ───────────────────────────► §5.2  roll FORWARD
│     │  └─ Caused by application behaviour ─────────────────► §5.2  fix, then repair rows
│     │
│     └─ Is the data MISSING?
│        ├─ A few rows, and you know which ─────────────────► §5.1  restore to scratch, copy back
│        ├─ A table or the whole database ──────────────────► §5.4  restore into a named database
│        └─ Present but was wrong for a long time ──────────► §5.3  choose an archive, then MERGE
│
└─ Is it a hand that vanished mid-play, and everything else is fine?
   └────────────────────────────────────────────────────────► §6  NOT RECOVERABLE, by design
```

At every leaf, the first action is the same: **restore into a scratch database.** Nothing in
this tree begins with writing to the live one.

---

## 5. The scenarios

### 5.1 Accidental deletion of specific rows

*A row deleted by hand, a `DELETE` with the wrong `WHERE`, an account-deletion flow
(`0004_account_deletion.sql`) run against the wrong user.*

**RPO 24 h. RTO 45 min.** Everything that user did since the last backup is not in it.

```bash
# 1. Restore the newest good archive into a scratch database. Never over the live one.
node scripts/backup.mjs restore --target prl_recover_$(date -u +%Y%m%d)

# 2. Look at what is there before copying anything back.
psql "$SCRATCH_URL" -c "select id, display_name, created_at from prl.users where id = '…';"

# 3. Copy the rows across, respecting foreign keys: users, then rooms/room_members,
#    then hands, hand_seats, hand_actions, then lesson_progress and the attempt tables.
#    Sessions are deliberately NOT copied: a restored session row would resurrect a token
#    that was invalidated, and the learner can start a new one.
```

**The trap.** Restoring the whole database to recover three rows destroys everything written
since the backup. That is a bigger incident than the one being fixed, and it is the most common
way a recovery goes wrong. Scratch, then copy.

### 5.2 A migration or an application bug wrote wrong data

*A migration with a bad `UPDATE`; a release that recorded hand actions incorrectly for a day.*

**RPO 24 h. RTO 2 h, because it needs code.**

**There is no rollback.** `docs/RUNBOOK.md` §11.3 is explicit and `migrate.mjs down` refuses
by design: a `down` script is code that has never run against the database it is asked to
save, and it cannot bring back data a forward migration removed. So:

1. **Stop the bleeding** — roll the *application* back to the previous release. Migrations are
   additive-first, so the older release runs against the newer schema. Leave the schema alone.
2. **Restore the last good archive into a scratch database** and diff the affected tables
   against live. This is what tells you the blast radius, and it is not guessable.
3. **Write the next migration** — the next free number, never an edit to an applied file — that
   repairs the rows. (`db/migrations/` holds `0001`–`0006` today, so the next one is `0007`; this
   step used to name `0005`, which has been taken since 2026-08-25.)
   Applied migrations are immutable, contents and filename, and the checksum ledger enforces it.
4. If the damage is unrepairable by SQL, treat it as §5.3.

**Note the destructive-statement gate.** `migrate.mjs up` refuses a pending migration
containing `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DELETE FROM` or a `RENAME` unless the file
declares `-- prl:irreversible: <reason>`. A repair migration that deletes rows will hit this.
That is the gate working: write the reason.

### 5.3 Corruption discovered late

*The hand history has been subtly wrong for three weeks. Somebody noticed today.*

This is the scenario the monthly archives exist for, and the hardest one, because **both**
copies are partly right: the old archive has good data and is missing three weeks; the live
database has three weeks and is corrupt.

**RPO: whichever archive predates the corruption — up to 6 months back. RTO 2-4 h, dominated
by deciding what to merge, not by restoring.**

1. Establish when it started (§3.1). Without that, everything below is guesswork.
2. `backup list` and pick the newest archive from *before* that date. Restore it to scratch.
3. **Decide per table, not for the database as a whole.** Typically: take the corrupted
   table's rows from the archive, keep everything else from live. A whole-database rollback
   throws away three weeks of correct progress to fix one table.
4. If the corruption predates every archive, it is not recoverable. Say so plainly, write down
   what was affected, and fix forward.

**Why six months and not longer.** Beyond that, restoring is usually worse than living with
the damage: the schema has moved on (roll-forward only — a nine-month-old dump restores under
a schema the current release does not serve), and reverting data that old destroys more than it
recovers. A retention window longer than the window in which restoring is the right answer is
storage, not protection.

### 5.4 The database is destroyed

*Volume deleted, instance terminated, `DROP DATABASE` on the wrong target, unrecoverable
storage failure.*

**RPO 24 h. RTO 30 min.** This is the scenario the tooling is shaped around, and the one
rehearsed in `backup-restore.md` §7.

**Rehearsed end to end on 2026-08-25** against a virgin `postgres:16-bookworm` container, from
an encrypted archive of the 944,297-row development database: both routes below were run, and
the measurements are theirs. Route (b) failed on that rehearsal and the fix is in
`scripts/backup.mjs` — see `neutraliseGrantedBy`. Do not treat the numbers as the production
RTO: this was a 149.8 MiB database on loopback, and `pg_restore` is linear in size.

```bash
# 1a. Roles first. They are cluster-wide and are NOT in a single-database dump; without them
#     every ALTER ... OWNER and GRANT in the dump fails on a fresh cluster with
#     `role "prl_migrator" does not exist`. Measured: this is exactly what happens.
DATABASE_MIGRATION_URL="$ADMIN_URL" node apps/api/scripts/migrate.mjs roles
#     This route leaves the cluster with prl_migrator and prl_app and NO LOGIN ROLES. The
#     identities the API and the deploy pipeline connect as — prl_api, prl_deployer — have to
#     come from the secret manager afterwards (RUNBOOK §5). Measured: restore 46.5 s,
#     verify-schema exit 0, `migrate status` 6 applied and matching, schema owner prl_migrator.

# 1b. Or, on a genuinely fresh cluster, use the archive's own globals — one command, and it
#     also carries the login roles and their SCRAM verifiers, which `migrate.mjs roles` does
#     not. Measured: 45.2 s, all five roles and both memberships present afterwards.
#     node scripts/backup.mjs restore --with-globals --target poker_risk_lab …

# 2. Restore. Pass --id unless the archive directory holds archives of exactly one database:
#    with more than one source, restore refuses rather than reaching for the newest file.
node scripts/backup.mjs restore --target poker_risk_lab_restored

# 3. Prove it, before pointing anything at it.
DATABASE_URL="$RESTORED_URL" node apps/api/scripts/verify-schema.mjs      # must exit 0
DATABASE_MIGRATION_URL="$RESTORED_ADMIN_URL" node apps/api/scripts/migrate.mjs status
psql "$RESTORED_ADMIN_URL" -c \
  "select nspname, pg_get_userbyid(nspowner) from pg_namespace where nspname='prl';"
#    must answer prl_migrator — db:verify check 6b covers this now, and §11.4 documents the
#    restore that exits 0 with every relation owned by the runtime role instead.

# 4. Point the API at it and roll. `/api/v1/ready` is the gate: it queries the database.
```

**What learners see.** Sessions are rows, so everyone is signed out. Guests are first-class
accounts; a guest whose account row predates the backup keeps their progress, and one created
after it is gone entirely and cannot prove they existed. That is the single worst consequence
of a restore here and the reason the RPO is a day rather than a week.

### 5.5 Total host or cluster loss

*The machine, the region, or the account is gone.*

**RPO 24 h, if and only if the archives are not on that machine. RTO 4 h.**

The database restore is the fast part (§5.4). The rest is the reason the RTO is hours:
provisioning, a PostgreSQL 16 cluster, DNS, TLS certificates, pulling the images for the
release commit, `SESSION_COOKIE_SECRET` and the OIDC client secret out of the secret manager,
and the proxy configuration from `docs/RUNBOOK.md` §11.2.

**The prerequisite, and it is absolute: the archives and the key must not live only on the
host being backed up.** A backup on the disk that just failed is not a backup. `PRL_BACKUP_DIR`
should be remote storage or replicated off the host on its own schedule, and the key belongs in
an escrow that is not that host either.

**Restore `SESSION_COOKIE_SECRET` from the secret manager, do not generate a new one.** A new
secret invalidates every session cookie in existence, which turns a database recovery into a
sign-out for everybody who was unaffected.

### 5.6 The archives were destroyed too

*Ransomware, a compromised backup host, a delete that reached the archive directory.*

**Not recoverable.** There is nothing to restore from. This is the failure mode that the
retention rules cannot help with, because it is not about retention.

What actually prevents it, and none of it is this script's job:

* the archive directory on a **different filesystem** to the database, replicated **off the
  host**;
* an offsite copy the backup host **cannot delete** — object storage with versioning and a
  retention lock, or a pull-based copier that connects *to* the backup host rather than the
  backup host pushing outward;
* `prune --apply` running only after `verify` passes (the shipped unit does exactly this), so
  automated deletion cannot be the thing that finishes the job;
* the newest good backup being undeletable by policy — `selectForRetention` will not put it in
  a delete set, so a mis-set retention flag cannot empty the directory.

If it happens: the current database is all there is. Take a backup of it immediately, to a
different location, before doing anything else.

### 5.7 The archive key is lost

**Not recoverable, by design.** An archive whose key is gone is noise. There is no escrow
inside the archive, no key hierarchy, and no recovery path — that is what "encrypted at rest"
means when it is true.

Prevent it: escrow the key somewhere that is not the backup host, and **test the escrow by
decrypting a real archive with the escrowed copy**. An untested escrow is a belief.

If it happens: the current database is all there is, and every historical archive is
permanently unreadable. Generate a new key and start again — and note that archives taken with
the old key are not merely unreadable, they are also unprunable in any meaningful sense, since
`list` cannot verify their manifests. Delete them deliberately.

---

## 6. What this architecture cannot recover: the hand in progress

**A crash or restart mid-hand loses that hand, and no backup can bring it back.**

This is not a gap in the backup tooling. It is a consequence of ADR 0001, stated in
`apps/api/src/rooms/registry.ts` and repeated in `docs/RUNBOOK.md` §11.1:

> the authoritative live state is this process's memory … this design assumes one API process
> per room

The `HandState` of a hand being played — the deck order, the hole cards, the betting state
mid-street — exists **only in the API process's memory**. It is deliberately not in the
database, and `apps/api/scripts/verify-schema.mjs` check 1 enforces that: no column anywhere
may store the deck or the commitment salts, so that a database read cannot expose the undealt
cards of a live hand. That is a hidden-information guarantee (ADR 0003, ADR 0004), and this is
its price.

**What survives a restart:**

* the room, its seats and its members;
* every **completed** hand, its seats and its action sequence, archived to PostgreSQL;
* the bots, which rehydrate into their seats from `room_members.bot_profile` — migration
  `0003_bot_seat_recovery.sql` exists for exactly this, and before it seven of the twelve
  strategy profiles came back as `unknown`;
* every learner's units, progress and history.

**What does not:**

* the hand in progress. Its deck, its hole cards, the bets on the table, the street. Gone.
* the WebSocket connections, which receive a `4503 serverShuttingDown` close frame on a
  graceful shutdown and reconnect to a table with no hand in progress.

**Do not paper over this.** A learner mid-hand when the API restarts sees the hand disappear.
The correct product behaviour is to say so, not to invent a hand. The correct operational
behaviour is to keep API restarts rare and graceful: `SHUTDOWN_GRACE_MS` with an orchestrator
grace period **above** it (§10 of the runbook), and one replica or genuine room affinity
(§11.1) so a restart is one event rather than a rolling series of them.

The RPO for an in-flight hand is therefore "the hand", and there is no RTO because there is
nothing to restore. Making it recoverable would mean persisting deck order and hole cards,
which the threat model forbids, or a durable event log of every action with the deck derived
from a stored seed — a substantially different system, and not one worth building for a
teaching app where the answer to a lost hand is to deal another.

---

## 7. What else is NOT covered

* **Point-in-time recovery.** No WAL archiving. The RPO is the schedule interval, full stop.
* **The API and web applications.** Rebuilt from the image at a release commit; nothing about
  them is in a backup, and nothing should be.
* **Secrets.** `SESSION_COOKIE_SECRET`, the OIDC client secret, `PRL_BACKUP_KEY` itself.
  A secret manager's job. Note that the *globals* archive does contain the login roles' SCRAM
  verifiers, which is why it is encrypted.
* **Logs.** stdout, collected by the platform, with the platform's retention. Hand history is
  in PostgreSQL; logs are for incidents.
* **The proxy configuration and TLS certificates.** Infrastructure-as-code or the platform.
* **Anything that was never written down.** If it only existed in the memory of the API
  process, see §6.
* **Automatic failover.** There is none. Every scenario here is a human deciding to restore.
  For a six-max invite-only teaching tool that is the right trade; if it stops being, the piece
  to add is a streaming replica, and that is a database deployment decision.

---

## 8. Keeping this document true

A recovery plan nobody has executed is a hypothesis. Three habits, in decreasing frequency:

* **Weekly, automatically:** `prl-backup-verify.timer` runs `verify --all`, then
  `verify --deep` (a real restore into a scratch database), then `prune --apply`. Nothing is
  pruned unless verification passed.
* **Per release:** the pre-deployment checklist in `backup-restore.md` §10.
* **Quarterly, by a human:** rehearse §5.4 end to end against a *copy* of production, to the
  standard in `backup-restore.md` §7 — `db:verify` exit 0, ownership checked by hand, the API
  answering `/ready`, and the authorisation check in §7.8. Then update the measured RTO in
  §2 of this document with what it actually took, and note who did it and when.

`pg_restore` exiting 0 is not the test. `db:verify` exiting 0 against the restored database is
the test, and a fresh guest being refused somebody else's restored room is the other half of
it.
