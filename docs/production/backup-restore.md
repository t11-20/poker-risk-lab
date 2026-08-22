# Backup and restore

The procedure, the retention policy, the encryption design, the verification method, and the
evidence from a restore that was actually performed.

`docs/RUNBOOK.md` §11.4 describes dump-and-restore **by hand**, and it is still correct and
still worth reading — every trap it names is one this tooling now enforces rather than
documents. What it could not do was happen on its own, and its own closing sentence said so:

> **No gate enforces any of this.** `db:verify` runs inside `pnpm run verify` against the
> *development* database, which proves the checks work; nothing in the repository restores a
> dump.

This document is the other half. `scripts/backup.mjs` is the tool, `deploy/backup/` is the
schedule, and §7 below is a restore that was performed on 2026-08-22 with its real output.

---

## 1. What is being protected, and what is not

PostgreSQL is the only durable state in this system. It holds:

* **learner accounts** — guests are first-class accounts, so a guest's identity is a row, not
  a cookie;
* **lesson, quiz and scenario progress** — the entire record of what a learner has worked
  through;
* **hand history** — the archived hands and their action sequences, which is the thing the
  product promises is verifiable after the fact;
* **the audit log**;
* **session token hashes, keyed IP hashes and invite-code hashes** — never the raw values
  (`apps/api/scripts/verify-schema.mjs` checks 1 and 2 enforce that against the live schema).

**What no backup here can recover: the hand that is in flight.** ADR 0001 puts the
authoritative `HandState` in the API process's memory, and `docs/RUNBOOK.md` §11.1 spells out
the consequence — one API process per room, restarts drop live rooms. A crash mid-hand loses
that hand. Bots rehydrate into their seats from `room_members.bot_profile` (migration
`0003_bot_seat_recovery.sql`), so the *table* comes back; the deal in progress does not. This
is a deliberate architectural trade, not a gap in the backup, and no amount of WAL archiving
would change it because the state was never in the database. See
`docs/production/disaster-recovery.md` §6.

**Also not covered:** the API and web containers (rebuilt from the image at a release
commit), the proxy configuration, `SESSION_COOKIE_SECRET` and the OIDC client secret (a
secret manager's job — and note that restoring an *old* `SESSION_COOKIE_SECRET` is what makes
existing session cookies keep working), and anything in a log stream.

---

## 2. The archive

Each run of `backup create` writes three files:

| File | Contents |
| --- | --- |
| `<id>.dump.enc` | `pg_dump --format=custom` of the application database, encrypted |
| `<id>.globals.sql.enc` | `pg_dumpall --globals-only`, encrypted |
| `<id>.manifest.json` | metadata, checksums and a row census, HMAC-signed |

`<id>` is `prl-<database>-<YYYYMMDDTHHMMSSZ>`, so the directory sorts chronologically and the
UTC instant is unambiguous in the filename.

### Why the globals dump is taken every time

`pg_dump` of one database never contains a `CREATE ROLE`. `prl_migrator` and `prl_app` are
cluster-wide, and the dump is full of `ALTER ... OWNER TO prl_migrator` and `GRANT ... TO
prl_app` statements that have nothing to attach to on a fresh cluster. §11.4 says to keep a
globals dump beside each backup and **nothing in the repository produced one**. Now `create`
does, and skipping it requires `--no-globals`, which prints:

```
  ! globals NOT captured (--no-globals)
      a full-cluster rebuild from this archive cannot recreate prl_api or prl_deployer
```

### Why the dump keeps its owners and privileges

No `--no-owner`, no `--no-privileges`. §11.4 measured what that costs: `pg_restore` exits 0 —
which is the dangerous part, it looks like success — and the resulting database has every row
and every index with **all 54 relations owned by `prl_api`**, the runtime role, which
therefore holds `CREATE` on the schema and can `DROP` every table it serves. The entire
least-privilege posture, inverted, in a database that looks fine.

`verify` has a cheap detector for a dump taken the wrong way: the count of ACL entries in the
table of contents. A correct dump of this database has **16**; a `--no-privileges` dump has
0, and `verify` fails on it by name.

---

## 3. Encryption

### The design

* **AES-256-GCM**, from `node:crypto`. No new dependency: a backup tool that pulls a crypto
  library into the dependency graph adds a supply-chain surface to the one artefact that has
  to survive a supply-chain incident.
* **HKDF-SHA-256** derives a distinct key per archive *and* per payload from the 32 bytes of
  key material, over a fresh random 32-byte salt recorded in the manifest. The database dump
  and the globals dump in one backup are encrypted under different keys.
* **Framed, not one stream.** The payload is a sequence of independently sealed 1 MiB frames.
  Each frame's nonce is a random per-archive prefix plus a counter; each frame's AAD is
  `sha256(header bytes) || counter || finalFlag`.
* **A terminator frame** (empty plaintext, final flag set) ends every archive.
* **The manifest is HMAC-SHA-256 signed** under a key derived the same way.

### Why framed rather than a single AEAD stream

A single `createCipheriv` over the whole dump would be simpler, and its authentication tag
arrives at the **end**. A streaming restore would therefore have to feed unauthenticated
plaintext to `pg_restore` and discover the forgery after `pg_restore` had already executed
it. Restoring attacker-chosen SQL and then reporting a bad tag is not integrity.

With frames, `restore` streams frame by frame and nothing reaches `pg_restore` that has not
already had its tag checked. Binding the counter and the header hash into the AAD is what
makes frames non-interchangeable: reordering them, splicing one in from another archive,
dropping the tail, or editing the header all fail the tag rather than producing plausible
SQL. The terminator is what makes truncation detectable at all — without it, "the file stops
here" is indistinguishable from "the file is complete."

**The cost, stated:** 20 bytes per megabyte of overhead, and a format only this script reads.
`openssl enc` will not open it. That is why `restore` and `verify` are subcommands rather than
a paragraph telling an operator to pipe things together during an incident.

### Why the manifest is signed

The manifest holds the checksums. Whoever can corrupt an archive on the backup host can
equally rewrite a plain-JSON checksum to match it, after which "the checksum matched" means
nothing at all. §6 below demonstrates that attack and the signature catching it.

The manifest is deliberately **not** encrypted: an operator has to be able to tell what a file
is before deciding whether to go and find the key for it. What it discloses is the database
name, timestamps, file sizes, digests and per-table row counts — metadata, no row of any
table. The row counts are the disclosure worth naming out loud; they are there because
comparing them after a restore is what catches the failure that actually happens, which is a
restore that produced the schema and none of the data.

### Key management, honestly

The key is 32 bytes from `PRL_BACKUP_KEY` or `--key-file`. There is **no `--key` flag**,
because an argument is visible in `ps`, in shell history, and in any process listing the host
ships to a log collector.

**What this protects against:** somebody who obtains the archive but not the machine — a
stolen bucket, a cloned volume, a decommissioned disk, a snapshot shared with the wrong
account, a misdirected transfer. That is the realistic threat for offsite copies, and it is a
serious one here: the plain form of this backup set is a full copy of every learner's account
*and*, in the globals dump, the SCRAM verifiers of `prl_api` and `prl_deployer`.

**What it does not protect against, precisely:**

* anyone who can read the backup process's environment — `/proc/<pid>/environ`, a core dump,
  `docker inspect`, a CI job that echoes its environment, an `EnvironmentFile` readable by
  more than root;
* anyone with code execution on the backup host while a backup runs;
* a compromised source database — encryption protects the copy, not the contents;
* **rotation, revocation and audit.** One static key encrypts every archive it is used for.
  There is no per-archive escrow, no key hierarchy with a revocable branch, and no record of
  who decrypted what. Getting those means a KMS or HSM holding a root key and this script
  asking it to unwrap a per-archive data key. `encryption.keyId` in the manifest is reserved
  for exactly that and is `null` today, because there is one static key and saying otherwise
  would be decoration;
* **losing the key.** There is no recovery. Escrow a copy somewhere that is not the backup
  host, and test the escrow.

---

## 4. Retention policy

**7 daily, 4 weekly, 6 monthly.** Grandfather-father-son over UTC buckets: within each day,
week and month that has a backup, the newest one is that bucket's representative, and the most
recent 7 days, 4 ISO weeks and 6 months are kept. One archive can hold all three slots at once.

Steady state is **13 to 17 archives**, roughly 200 days of coverage.

### Why these numbers, for this application's data

Start from what losing a day costs. This is a play-money teaching app; there is no money, no
regulated record, no legal retention obligation, and nothing here is anyone's system of
record for anything. What a learner loses in a day is:

* **their lesson and scenario progress for that day** — irreplaceable in the sense that
  matters. Nobody can reconstruct which lessons somebody read, and the app's whole value to
  that person is the record of what they have worked through. It is not catastrophic; it is
  demoralising, and it is exactly the kind of loss that makes someone stop coming back;
* **their hand history for that day** — the hands themselves are gone. Every review feature
  reads from it, and a hand nobody can review is a lesson that cannot be taught;
* **their session** — sessions are rows, so a restore signs people out. Guests are
  first-class accounts, and a guest whose account row is missing has no way to prove they are
  the same person. They restart from zero. That is the worst single consequence of a restore
  here, and it is the reason the RPO is a day rather than a week.

Nobody's money is at stake. So:

* **7 dailies.** A week is long enough to notice a bad Monday from the following Friday, which
  is the realistic detection window for a small team. Under a day of loss for the common case.
* **4 weeklies.** A month, for the failure that is discovered late: a migration that quietly
  corrupted a column, an application bug that wrote wrong rows for a fortnight. Daily
  granularity is useless there because every daily already contains the corruption; what you
  need is a copy from before it started.
* **6 monthlies.** Half a year is the outer bound on "we found something in the hand history
  that has been wrong for a while." Beyond six months, restoring is worse than living with it:
  the schema has moved (roll-forward only, §11.3, so a nine-month-old dump restores under a
  schema the current release does not serve) and the data is stale enough that reverting to it
  would destroy more than it recovers. **A retention window longer than the window in which
  restoring is the right answer is storage, not protection.**
* **Storage cost is not what decides this.** The development database dumps to 153 KiB
  encrypted; a realistic production database is single-digit gigabytes. 17 archives is
  affordable at any of those sizes, so the limits above are chosen for the recovery window
  and not for the disk.

### The rule that overrides the policy

**The newest good backup is never deleted, whatever the policy says.** Not the newest backup —
the newest *good* one, meaning its manifest signature verified and every file it names is
present at the recorded size. Three ways the plain reading gets somebody hurt:

1. `--daily 0 --weekly 0 --monthly 0` is a legal policy and, without the rule, deletes
   everything;
2. clock skew or a timezone mistake puts every bucket in the past and every archive falls out
   of the window on one run;
3. the newest archive is corrupt — and deleting the newest *good* one because a broken newer
   file occupies today's slot is precisely the moment retention destroys the recovery.

For the same reason, a corrupt archive can never be a bucket's representative: it must not
hold a slot and evict the intact one beneath it. Broken archives are still deletable; they
simply cannot protect themselves or displace something that works.

`scripts/backup.test.mjs` proves all of this with negative controls, including the zero policy
(exactly one survivor, and the assertion says which) and the corrupt-newest case.

### `prune` deletes nothing unless told to

`prune` prints a plan. `prune --apply` deletes. The weekly unit runs `verify --all`, then
`verify --deep`, then `prune --apply`, in that order, as a `Type=oneshot` service that aborts
on the first failure — so a prune never runs after a failed verification.

---

## 5. RPO and RTO

Neither was defined anywhere in this repository before this document.

| | Target | How it is measured | Measured 2026-08-22 |
| --- | --- | --- | --- |
| **RPO** | **24 hours** | age of the newest *good* archive (`backup list`) | schedule interval; nightly timer at 02:30 UTC |
| **RTO** | **30 minutes** | restore, `db:verify`, API answering `/ready` | **1.04 s** (10 MB dev database, §7) |

### Why 24 hours, and what it would take to do better

There is no WAL archiving here, so the RPO **is** the schedule interval. Nothing else is
possible with periodic dumps: everything written since the last dump is gone.

24 hours is the right number for this application because the loss it admits — one day of
lesson progress and hand history for a play-money learning tool — is disappointing and not
damaging. A tighter RPO is a real option and it is a real cost: `archive_command` plus a base
backup gets to minutes, and it brings continuous archive storage, WAL retention management, a
second thing to monitor, and a restore procedure with two stages instead of one. That is a
change to the database deployment, not to this script. **If the RPO ever needs to be minutes,
the answer is WAL archiving, not running this timer more often** — four dumps a day gives a
6-hour RPO and four times the load for it.

The RPO is *measurable*, which matters more than the number: `backup list` shows the newest
good archive and its age, and an archive older than 24 hours is an SLO breach that something
should be paging about.

### Why 30 minutes, and where that number stops being true

30 minutes is the time from "we have decided to restore" to "the API is serving the restored
database". It is chosen against what this application is: an invite-only learning tool with no
revenue per minute and no external system depending on its availability. Half an hour of
downtime in a genuine data-loss incident is acceptable; 30 minutes is also comfortably longer
than every measurement below, which leaves room for the parts a stopwatch does not capture —
deciding, finding the key, and someone reading this document.

**The measurements, and the honest extrapolation.** From §7 and §8:

| Database | Archive | `create` | `restore` (decrypt + `pg_restore`) | Full drill |
| --- | --- | --- | --- | --- |
| 10 MB, 1,000 rows, 13 tables | 153.5 KiB | 0.27 s | 0.18 s | **1.04 s** |
| same schema, 43,817 rows | 6.6 MiB | 0.50 s | 1.19 s | — |
| 1,260 MB, 2,000,000 rows + index | 287.8 MiB | 12.19 s | 28.75 s | — |

The middle row is the same development database a few hours later, after another workstream's
load test had put 32,000 hand actions into it. It is here because it is the only measurement
of this *schema* — thirteen tables, foreign keys, 41 indexes — at a size where the number is
not pure overhead, and because a restore that got 44x more data for 6.6x the time is the
shape you want to see.

That is roughly **44 MB of database restored per second**, and the restore is dominated by
`pg_restore` (index rebuilds and constraint checks), not by decryption — layers 1-3 of
`verify`, which check the whole archive's checksum *and* authenticate every frame, took 0.755 s
for the same 287.8 MiB.

**Where the 30-minute target fails.** Linear extrapolation puts a 100 GB database at roughly
40 minutes of `pg_restore` alone, which blows the target. If this database ever approaches
that size, the fix is parallel restore (`pg_restore --jobs`), and there is a real constraint in
the way: `restore` streams the decrypted dump into `pg_restore` on stdin, and a parallel
restore needs a **seekable** archive. Supporting it means staging the decrypted dump to a file
first — which puts an unencrypted copy of the whole database on disk, exactly what this design
avoids — or decrypting into a `tmpfs` sized for it. That trade has not been made, because at
the sizes this application actually has it buys nothing. It is written down here so the day it
matters, the reason is on record rather than rediscovered.

---

## 6. Verification: four layers, and what each one actually proves

`verify` does not have "an integrity check". It has four, and each supports a strictly
different sentence. Conflating them is how a backup system passes its own checks for years and
then cannot restore.

| Layer | Check | What it proves | What it does NOT prove |
| --- | --- | --- | --- |
| 1 | manifest HMAC | the checksums below are the ones recorded at dump time | nothing about the archive itself |
| 2 | sha256 of the ciphertext | the bytes did not rot | **nothing about whether `pg_restore` can read them** |
| 3 | authenticated decryption, frame by frame, to the terminator | the archive is complete, unaltered, and decrypts to the exact plaintext `pg_dump` produced | that `pg_dump` produced a *usable* archive |
| 4 | `pg_restore --list`; with `--deep`, a real restore into a scratch database and a census comparison | `pg_restore` parses the table of contents; with `--deep`, that it can execute the whole thing | that the *application* works against it — §7 |

Layer 2 is the one people mean when they say "we checksum our backups", and on its own it is
the weakest claim in the table. A dump truncated by a full disk hashes perfectly, every time,
forever. Layer 3 is what catches that, and only because of the terminator frame.

Layers 1-3 need no database at all, so an operator can verify an offsite copy on a laptop.
`--deep` needs a cluster it can create a scratch database on, and it drops that database in a
`finally` — a verification run that leaves a copy of production lying around has created the
exposure the encryption exists to prevent.

### The layers demonstrated against a real archive, 2026-08-22

**A. One flipped byte deep inside the ciphertext, manifest untouched.** Layer 2 catches it:

```
$ node scripts/backup.mjs verify --id prl-poker_risk_lab-20260822T131058Z --dir ... --key-file ...
  ✓ 1. manifest signature verifies
      so the checksums below are the ones that were recorded at dump time
  ✗ 2. prl-poker_risk_lab-20260822T131058Z.dump.enc does NOT match its checksum
      recorded ab13d688f8acc0d5… over 157211 bytes, found 2ffcba61b7391c16… over 157211 bytes
  FAIL verification                                                      → exit 1
```

**B. Then repair the checksum in the manifest, so layer 2 passes.** This is the attack a plain
sha256 sidecar cannot survive. Layer 1 catches it:

```
  rewrote cipherSha256 to match the corrupted file
  ✗ 1. manifest signature does NOT verify
  FAIL verification                                                      → exit 1
```

**C. Truncate the archive by 4,000 bytes, repair the size and checksum, and re-sign the
manifest with the real key.** Now layers 1 and 2 both pass, and there is nothing a checksum
can do. Layer 3 catches it:

```
  truncated the archive by 4000 bytes, then rewrote size and checksum to match
  re-signed the doctored manifest with the real key
  ✓ 1. manifest signature verifies
  ✓ 2. prl-poker_risk_lab-20260822T131058Z.dump.enc matches its checksum
      bytes did not rot — this proves nothing about whether pg_restore can read them
  ✗ 3. prl-poker_risk_lab-20260822T131058Z.dump.enc failed authenticated decryption
      the file is truncated — a partial write, a full disk, or an interrupted copy
  FAIL verification                                                      → exit 1
```

**D. The ACL detector firing on a real dump.** The scale-probe database in §8 was a bare
schema with no grants, and `verify` refused it on exactly that basis, unprompted:

```
  ✓ 4. pg_restore parsed 5 table-of-contents entries
  ✗ 4. the dump carries no ACL entries
      it was taken with --no-privileges; see RUNBOOK §11.4
```

**E. The encryption does not leak the plaintext.** Searched both encrypted files for the
`pg_dump` custom-format magic, the SCRAM verifier prefix, and the role names:

```
absent: PGDMP          absent: SCRAM-SHA-256    absent: CREATE
absent: ROLE           absent: prl_api
```

The only readable string in either file is the archive id in the plaintext header, which is by
design and is covered by every frame's AAD (demonstration D in `scripts/backup.test.mjs`:
editing it breaks every frame).

---

## 7. The restore that was actually performed

Run on 2026-08-22 against the development cluster: PostgreSQL 16.15 in
`poker-risk-lab-postgres-1` (`postgres:16-bookworm`), Node 24.18.0, `pg_dump` 16.15 executed
inside the database container. Every block below is real output.

### 7.1 Take the backup

```
$ node --env-file-if-exists=.env scripts/backup.mjs create \
    --dir "$ARCHIVES" --key-file "$KEY" --container poker-risk-lab-postgres-1

backup create
  source    poker@127.0.0.1:5432/poker_risk_lab
  tools     inside container poker-risk-lab-postgres-1

  ✓ database dumped and encrypted  153.5 KiB in 0.11s
      2 frames, plaintext 153.2 KiB
  ✓ cluster globals dumped and encrypted  1.9 KiB
      contains the login roles and their SCRAM verifiers — this is why the archive is encrypted
  ✓ row census taken  13 tables, 1000 rows
      taken immediately after the dump, in its own snapshot — corroboration, not proof
  ✓ manifest written and signed

  Summary
    archive     prl-poker_risk_lab-20260822T131058Z
    files       3 (2 encrypted payload(s) + manifest)
    on disk     155.4 KiB
    elapsed     0.27s

  PASS backup created                                                    → exit 0
```

### 7.2 Verify it, all four layers, including a real scratch restore

```
$ node --env-file-if-exists=.env scripts/backup.mjs verify --deep --dir ... --key-file ... \
    --container poker-risk-lab-postgres-1

  ✓ 1. manifest signature verifies
  ✓ 2. …dump.enc matches its checksum
  ✓ 3. …dump.enc decrypts to the recorded plaintext
       2 frames authenticated, terminator present, 153.2 KiB recovered
  ✓ 2. …globals.sql.enc matches its checksum
  ✓ 3. …globals.sql.enc decrypts to the recorded plaintext
  ✓ 4. pg_restore parsed 146 table-of-contents entries
       16 ACL entries — a dump with 0 of these restores a database prl_app has no rights in
  ✓ 4. restored into a scratch database and dropped it  (0.58s)
       13 tables compared

  PASS verification                                                      → exit 0
```

16 ACL entries is the same number `docs/RUNBOOK.md` §11.4 measured by hand on 2026-08-19,
which is the cross-check that this tooling is looking at the same thing that document is.

### 7.3 The refusals, exercised

Every one of these was run for real; none of them changed anything.

```
$ backup restore                                    # no --target
  ✗ refusing to restore
      --target is required: name the database to restore INTO. There is no default.
  FAIL nothing was changed                                               → exit 1

$ backup restore --target poker_risk_lab            # the live database
  ✗ refusing to restore
      database poker_risk_lab already exists. Restoring into it means DROPPING it first.
      Pass --drop-existing if that is what you mean, or choose a name that does not exist.
  ✗ refusing to restore
      poker_risk_lab is the database DATABASE_URL points at. Everything written since this
      backup would be destroyed. Pass --overwrite-live-database as well if that is genuinely
      the intent.
  FAIL nothing was changed                                               → exit 1

$ NODE_ENV=production backup restore --target poker_risk_lab \
    --drop-existing --overwrite-live-database
  ✗ refusing to restore
      NODE_ENV=production. A restore here destroys real learner progress and hand history.
      Pass --yes-i-am-restoring-production to acknowledge that, in addition to the flags above.
  FAIL nothing was changed                                               → exit 1

$ backup restore --target 'Robert;DROP'
  ✗ refusing to restore
      --target Robert;DROP is not a usable database name: lower-case ASCII, starting with a
      letter or underscore, at most 63 characters
  FAIL nothing was changed                                               → exit 1
```

Three separate dangers, three separate acknowledgements, deliberately not collapsed into one
flag: the common mistake is a fat-fingered `--target` naming the developer's own database, and
a single flag covering both that and "restore over production" hands the person who wanted the
first one the second for free.

### 7.4 Restore into a fresh database

```
$ node --env-file-if-exists=.env scripts/backup.mjs restore \
    --dir ... --key-file ... --container poker-risk-lab-postgres-1 --target prl_restore_drill

backup restore
  archive   prl-poker_risk_lab-20260822T131058Z  (2026-08-22T13:10:58.330Z)
  target    prl_restore_drill

  ✓ restored 153.2 KiB of dump into prl_restore_drill
      decrypt + pg_restore --exit-on-error --single-transaction, 0.18s
  ✓ row census matches the archive
      13 tables compared

  Summary
    restored    prl_restore_drill  (13 tables, 1000 rows)
    restore     0.18s  (decrypt + pg_restore)
    total       0.47s  (including create and census)

  PASS restore                                                           → exit 0
```

### 7.5 Migrations and schema are valid

`verify-schema.mjs` as **`prl_api`** — the runtime role, not a superuser, so the grants are
actually exercised:

```
$ DATABASE_URL='postgresql://prl_api:…@127.0.0.1:5432/prl_restore_drill' \
    node --env-file-if-exists=.env apps/api/scripts/verify-schema.mjs

schema verification
  · 120 columns across the prl schema
  · 41 indexes
  · bot_profile permits exactly the 13 runtime values
  · checked the delete action of 8 foreign key(s) referencing users
  · checked 12 tables for prl_app privileges
  · checked schema and every relation owner
  ✓ every documented schema security property holds                      → exit 0
```

**Why 120 and 12 here, when the same script reports 123 and 13 against the development
database.** `information_schema` is filtered by privilege: it shows only what the connecting
role may touch. This run connected as `prl_api`, which is granted nothing on
`prl.schema_migrations` (3 columns), so it cannot see that table and does not count it. A run as
the schema owner sees both. Neither number is wrong and neither database is missing anything —
which is exactly why `verify-schema.mjs` now prints the role beside the counts, so two
transcripts can be compared at all.

The migration ledger came back with it, so the restored database announces which release it
belongs to:

```
$ DATABASE_MIGRATION_URL='postgresql://prl_deployer:…@…/prl_restore_drill' \
    node --env-file-if-exists=.env apps/api/scripts/migrate.mjs status

  applied  0001_initial.sql                    2026-08-19T09:33:37.021Z
  applied  0002_indexes_and_constraints.sql    2026-08-19T09:33:37.108Z
  applied  0003_bot_seat_recovery.sql          2026-08-19T09:33:37.143Z
  applied  0004_account_deletion.sql           2026-08-22T13:09:19.205Z
  · 4 applied and matching, 0 pending                                    → exit 0
```

Ownership checked **by hand** as well, because §11.4's checklist says to and because this is
the property a restore silently gets wrong:

```
$ psql -d prl_restore_drill -c "select nspname, pg_get_userbyid(nspowner) from pg_namespace where nspname='prl';"
 nspname |    owner
---------+--------------
 prl     | prl_migrator

$ psql -d prl_restore_drill -c "select pg_get_userbyid(relowner), count(*) from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='prl' group by 1;"
    owner     | count
--------------+-------
 prl_migrator |    54
```

`prl_migrator` and nothing else, across all 54 relations. That is the posture §11.4 measured
the broken version of.

### 7.6 The application starts against it, and both probes pass

```
$ DATABASE_URL='postgresql://prl_api:…@127.0.0.1:5432/prl_restore_drill' PORT=3199 \
    node --env-file-if-exists=.env apps/api/src/server.ts
{"level":30,…,"msg":"Server listening at http://127.0.0.1:3199"}
{"level":30,…,"nodeEnv":"development","oidcEnabled":false,"routeModules":7,"msg":"listening"}

$ curl http://127.0.0.1:3199/api/v1/health
HTTP 200 in 0.012575s
{"status":"ok","version":"0.1.0","protocolVersion":1}

$ curl http://127.0.0.1:3199/api/v1/ready
HTTP 200 in 0.047532s
{"status":"ready","checks":{"database":{"ok":true}}}
```

`/ready` is the meaningful one: it queries the database, so a 200 here is the restored
database answering.

### 7.7 The data is there — table by table, against the source

Counted with the same query on both databases, at the same moment:

| Table | Source | Restored |
| --- | ---: | ---: |
| `audit_log` | 5 | 5 |
| `hand_actions` | 157 | 157 |
| `hand_seats` | 74 | 74 |
| `hands` | 36 | 36 |
| `lesson_progress` | 14 | 14 |
| `oidc_login_attempts` | 1 | 1 |
| `quiz_attempts` | 4 | 4 |
| `room_members` | 159 | 159 |
| `rooms` | 79 | 79 |
| `scenario_attempts` | 4 | 4 |
| `schema_migrations` | 4 | 4 |
| `sessions` | 197 | 197 |
| `users` | 266 | 266 |

All 13 tables identical. Representative user data (266 accounts), progress (14 lesson-progress
rows, 4 quiz attempts, 4 scenario attempts) and hand history (36 hands, 74 seats, 157 actions)
all present.

### 7.8 Authorisation still holds on restored data

A restore is not finished when the rows are back. The rows are back **for whom** is the
question, and it is the one nobody checks. Nine checks against the API running on the restored
database, including a positive control so that a refusal cannot be a broken endpoint wearing a
404:

```
PASS  a new guest can be created against the restored database
      HTTP 201 user=usr_oxadqybp5xhpcnu5xmi2u7izpz
PASS  that guest can create a room
      HTTP 201 room=room_my6nrp5ik43sffuj2v5vw3zqof
PASS  POSITIVE CONTROL: the owner CAN read their own room
      HTTP 200 Drill room
PASS  a second, unrelated guest exists
      HTTP 201 user=usr_y6cete44jqffkfet75xtyn4pdj
PASS  a stranger CANNOT read another guest's new room
      HTTP 404 room_not_found_or_not_permitted
PASS  THE REQUIREMENT: a new guest CANNOT read a RESTORED room that is not theirs
      GET /api/v1/rooms/room_devseed_home -> HTTP 404 room_not_found_or_not_permitted
PASS  a new guest sees none of the restored rooms in GET /rooms
      HTTP 200, 0 room(s) listed (the restored database holds 79)
PASS  a new guest inherits none of the restored learners' progress
      HTTP 200, lessonsCompleted=0, handsPlayed=0 (the restored database holds 14 lesson_progress rows)
PASS  a new guest sees none of the restored hand history
      HTTP 200, 0 hand(s) (the restored database holds 36)

ALL PASS (9 checks)
```

`room_devseed_home` is a room owned by a restored user (`usr_devseed_alice`). A brand-new
guest is refused it with `room_not_found_or_not_permitted` — the same answer they get for a
room that does not exist, which is the correct shape: a distinct "forbidden" would confirm the
room's existence to somebody with no right to know.

### 7.9 The measured RTO

A clean, cold end-to-end run — drop the target, restore, verify the schema, boot the API, wait
for `/ready` — with each phase timed:

```
restore_ms=598   verify_schema_ms=111 (exit 0)   api_boot_to_ready_ms=330   TOTAL_ms=1039
```

**1.04 seconds against a 30-minute target**, for a 10 MB database. §8 is the same pipeline at
a size where the number is interesting.

---

## 8. What it does at a realistic size

The development database is 10 MB, which measures startup overhead and not much else. A
scale probe was built to get an honest number: a throwaway database of 2,000,000 rows
(~256 bytes each) plus one btree index, **1,260 MB** on disk, dumped and restored through the
same commands.

```
=== CREATE (1260 MB database) ===
  ✓ database dumped and encrypted  287.8 MiB in 12.19s
      289 frames, plaintext 287.8 MiB
  ✓ row census taken  1 tables, 2000000 rows
    elapsed     12.50s                                         real 0m12.789s

=== VERIFY layers 1-3 (checksum + authenticated decrypt of 287.8 MiB) ===
  ✓ 2. …dump.enc matches its checksum
  ✓ 3. …dump.enc decrypts to the recorded plaintext                       real 0m0.755s

=== RESTORE (decrypt + pg_restore into a fresh database) ===
  ✓ restored 287.8 MiB of dump into prl_scale_restore
  ✓ row census matches the archive
    restored    prl_scale_restore  (1 tables, 2000000 rows)
    restore     28.75s  (decrypt + pg_restore)                  real 0m29.742s
```

Read from this:

* **Backup is cheap.** 12.2 s for 1.26 GB, dump and encryption together.
* **Verification is very cheap.** 0.755 s to checksum *and* authenticate 287.8 MiB — around
  380 MiB/s, on hardware with AES and SHA instructions. There is no excuse for not running it
  weekly.
* **Restore is the slow half, and the cost is `pg_restore`, not the crypto.** 28.75 s against
  0.755 s of decryption for the same bytes. Index rebuilds and constraint checks dominate.
* **The extrapolation, and where it breaks**, is in §5.

The probe database and its restore target were dropped afterwards.

---

## 9. Command reference

```bash
pnpm run backup keygen                    # a fresh 32-byte key. Escrow it.
pnpm run backup create                    # dump + globals + encrypt + sign
pnpm run backup list                      # inventory, retention class, integrity state
pnpm run backup verify                    # layers 1-4a on the newest archive
pnpm run backup verify --all              # layers 1-4a on every archive
pnpm run backup verify --deep             # + restore into a scratch database, then drop it
pnpm run backup restore --target <db>     # restore into a named database
pnpm run backup prune                     # print the retention plan
pnpm run backup prune --apply             # enforce it
```

`pnpm run backup` is an alias for `node scripts/backup.mjs`; the two are interchangeable, and
the direct form is what the systemd units use because they do not have a package manager on
`PATH`.

Common options: `--dir <path>` (or `PRL_BACKUP_DIR`), `--url <conn>` (or `DATABASE_URL`),
`--key-file <path>` (or `PRL_BACKUP_KEY`), `--container <name>` (or
`PRL_BACKUP_PG_CONTAINER`), `--id <archive-id>`, `--json`, `-q`. Full text in
`pnpm run backup --help`.

The archive directory defaults to `/var/backups/poker-risk-lab` and **deliberately not** to
anything inside the repository: a default of `./backups` would put an encrypted copy of every
learner's account one `git add -A` away from a public remote.

### On a developer machine

There is no local `pg_dump` in this project's toolchain — PostgreSQL runs in a container. Pass
`--container` and the client tools run inside it, which also guarantees they are the same major
version as the server:

```bash
node scripts/backup.mjs keygen -q > /tmp/prl-backup.key && chmod 600 /tmp/prl-backup.key
node --env-file-if-exists=.env scripts/backup.mjs create \
  --dir /tmp/prl-archives --key-file /tmp/prl-backup.key \
  --container poker-risk-lab-postgres-1
```

In that mode the host and port from `DATABASE_URL` are the wrong coordinates — they describe
the published port seen from outside — so the connection goes over the container's unix
socket, which is what the compose healthcheck does too. In production, leave `--container`
unset and install `postgresql-client-16` on the backup host: reaching the Docker socket is
root-equivalent on that host, and that is too much authority to hand a cron job.

## 10. The pre-deployment checklist, updated

`docs/RUNBOOK.md` §11.7 asks for "Backups scheduled **and a restore rehearsed**". Concretely,
that now means:

- [ ] `deploy/backup/` units installed and `systemctl list-timers 'prl-backup*'` shows both
- [ ] `PRL_BACKUP_KEY` generated per environment, **escrowed off the backup host**, and the
      escrow tested by decrypting an archive with the escrowed copy
- [ ] `/etc/poker-risk-lab/backup.env` is 0600 and root-owned
- [ ] `PRL_BACKUP_DIR` is on a filesystem that is not the database's, and is replicated off
      the host
- [ ] the backup role is its own role — not `prl_api`, not the superuser — with
      `pg_read_all_data`, `CREATEDB`, and membership of `prl_migrator`
- [ ] `backup verify --deep` has exited 0 on this environment's own archives
- [ ] a restore has been rehearsed to §7's standard: `db:verify` exit 0, ownership checked by
      hand, the API answering `/ready`, and the authorisation check in §7.8 — not merely
      `pg_restore` exiting 0
- [ ] `OnFailure=` wired to something that tells a human, in both `.service` files
- [ ] the RPO and RTO in §5 are agreed by whoever will be woken up, not just written here
