# Rollback

**The application rolls back. The schema does not.** Everything else in this document follows from that one asymmetry, and a deployment plan that has not internalised it will discover it during an incident.

The operational procedure is [`runbooks/rollback.md`](runbooks/rollback.md). This document is the policy and the reasoning: what "roll back" means here, what it costs, what makes a release un-rollbackable, and the concrete rules for whether the previous application can run against the schema the current one applied.

Companion documents: [`deployment.md`](deployment.md) for the forward path, [`architecture.md`](architecture.md) §8 for the migration model, `docs/RUNBOOK.md` §11.3 for the constraint as originally written, and [`backup-restore.md`](backup-restore.md) for the case where data is gone.

---

## 1. What can be reversed, and what cannot

| Thing | Reversible? | How |
| --- | --- | --- |
| The API and web images | **yes, exactly** | redeploy the previous digest. The images are immutable and content-addressed, so this is byte-identical, not "a build like the one we had" |
| Configuration and environment | yes | revert the variable and restart. The process refuses to boot on a bad one (exit 78) rather than serving oddly |
| The schema | **no** | there is no `down`. The recovery for a bad schema change is the *next* migration |
| Data a migration removed | **no** | a restore from backup, and only that |
| The hand in progress on any table | **no** | it lives in the API process's memory and dies with the process. This is ADR 0001's price |
| `SESSION_COOKIE_SECRET` | do not touch it | rotating it during a rollback signs out every learner who was unaffected |

---

## 2. Rolling back by previous image digest

The rollback target is a **digest pair**, not a version string.

```
api  prl-api@sha256:<64 hex>
web  prl-web@sha256:<64 hex>
```

### Where the digest comes from

The previous release's `release-manifest` artifact, uploaded by the `build` job of the release workflow with `retention-days: 90`. **That artifact is the rollback target**, which is why its retention is what it is. The `rollback-plan` job prints the current release's digests and names the previous release tag on every run, `if: always()`, because a rollback plan nobody has read is a rollback plan nobody can execute at 3am — and because the previous digest has to be captured *before* the new one is promoted or it is not available when it is needed.

Locally, the same pair is in `deploy/staging/release-manifest.json` for whichever commit last ran `pnpm run release:artifacts`. Note that this file is per machine and is overwritten by the next build: it is not a release archive.

### Roll both images together

The manifest names both digests as one release and they should move as one. Two concrete reasons from this repository's own history: the guest-bootstrap fix lives in `apps/web/src/lib/public-origin.ts` (web), and the Monte Carlo fix lives in the engine packages the API image carries. Rolling one image back to a release that predates its half of a paired fix reintroduces the defect while the other half is still deployed, which is a state nothing has ever tested.

### Why the digest is the identity

A tag is a pointer and can be repointed; a digest is the artefact. `image: prl-api@sha256:…` resolves to exactly those bytes or to nothing at all. A rollback expressed as a tag is a rollback to whatever that tag means today.

The honest caveat, the same one [`deployment.md`](deployment.md) §2 makes: today these are **local BuildKit image-store digests**, not registry-attested ones. They cannot be two different images, and nothing signed them. A rollback across machines needs a registry digest, and there is no registry in this repository.

### What a rollback costs

Rolling the API back restarts it, and **restarting the API drops every hand in progress** ([`architecture.md`](architecture.md) §3). Bot seats rehydrate from `room_members.bot_profile` and rooms reopen on next access, but the in-memory hand does not come back. `SIGTERM`, never `SIGKILL`: the graceful path answers in-flight requests and sends every WebSocket a `4503 serverShuttingDown` close frame, so clients say "the server is restarting" and reconnect. A client that sees `1006` is looking at a hard kill, which is what an orchestrator grace period equal to `SHUTDOWN_GRACE_MS` produces. Set the orchestrator's grace **above** the process's, never equal to it (`docs/RUNBOOK.md` §10, §11.6).

Web is stateless. Rolling it back costs a served page or two.

---

## 3. Rollback decision criteria

Roll back when **any** of these is true. These are the criteria the `rollback-plan` job prints with each release, so the list an operator reads at 3am is the list in the release's own summary:

- `/api/v1/ready` returns 503 for more than 2 minutes after the roll settles.
- The error rate (`prl_api_errors_total`) or the 5xx share is materially above the pre-deploy baseline. Use `/metrics`; that is what it is for.
- WebSocket sessions are closing with `1006` rather than `4503`. **This one points elsewhere:** `1006` means a hard kill, which indicts the orchestrator grace period rather than the release. Fix the grace period; rolling back will not help.
- **Hand history stops being written.** This is the silent failure that matters most, because the product's central promise is that a hand is verifiable afterwards. `prl_archive_failures_total` rising while play continues is the database, not the release — see [`runbooks/db-saturation.md`](runbooks/db-saturation.md).
- The smoke test fails against the production origin.

### When to fix forward instead

- **Configuration (exit 78).** The process printed every problem at once and never listened. Fix the variable and redeploy. Nothing is wrong with the artefact, and rolling back hides a misconfiguration that will recur. Do **not** "temporarily" satisfy a refused check with a placeholder — every one of those checks exists because a placeholder in production caused an incident once already.
- **A defect in a path nobody is hitting.** A rollback restarts the API and drops live hands; that cost has to be worth paying.
- **The release contains an irreversible migration.** Then there is no rollback to choose — §5.
- **The database is the problem, not the release.** [`runbooks/db-unavailable.md`](runbooks/db-unavailable.md) and [`runbooks/db-saturation.md`](runbooks/db-saturation.md) first. Rolling back an application because its database is unhappy changes nothing and costs every hand in progress.

---

## 4. Migrations: roll-forward only

`apps/api/scripts/migrate.mjs down` is a first-class command that **refuses**, and prints the policy:

```
✗ There is no `down`. Poker Risk Lab is roll-forward only, and this is the policy, not a
missing feature.
...
What to do instead:
  * The schema is wrong          write the next migration. Applied files are immutable;
                                 the fix is 0008, never an edit to 0007.
  * The release is bad           roll the APPLICATION back and leave the schema. Migrations
                                 are additive-first, so the previous release runs against
                                 the newer schema.
  * Data is gone                 restore from backup (§11.4). Nothing this script can do
                                 would recover it.
  * A development database       `reset` drops schema prl and reapplies everything. It
                                 refuses to run with NODE_ENV=production.
```

It is a command rather than an unrecognised argument on purpose: a deploy pipeline that asks for a rollback gets an answer, not `Unknown command "down"` — which reads like a version skew and sends an operator hunting for a missing release rather than reading a decision.

**Why there is no `down`.** A `down` script is code that has, by construction, never run against the database it is one day asked to save, and the first execution would be during the incident. It also cannot bring back data a forward migration removed — so in the case that actually needs undoing, the answer is a restore and not a reversed migration. A `down` file that recreates an empty column is theatre.

**The consequences, in order:**

1. The recovery for a wrong schema is the **next** migration. `0005`, never an edit to `0004`. Applied files are checksummed and immutable, contents and filename; the runner aborts rather than reapplying an edited one.
2. Never hand-edit `prl.schema_migrations` to make an error go away. That makes the runner's record a lie, and every future migration is applied against a schema nobody can describe.
3. The recovery for lost data is a restore ([`backup-restore.md`](backup-restore.md)), with the RPO that implies: **24 hours**, because there is no WAL archiving.
4. **Therefore the application must roll back onto the newer schema.** Migrations are additive-first precisely so that the previous release runs against the schema the current one applied.

---

## 5. What "roll back the app but not the schema" means for this schema

The contract is: **the previous release's code must run correctly against the schema the current release applied.** That is a property of each migration, decided when it is written, and it is what makes an application rollback possible at all.

There are four applied migrations today: `0001_initial.sql`, `0002_indexes_and_constraints.sql`, `0003_bot_seat_recovery.sql`, `0004_account_deletion.sql`.

### Changes the previous release tolerates

| Change | Why the old code is fine |
| --- | --- |
| A **new nullable column** | the old code neither selects nor writes it. `0003` added `room_members.bot_difficulty` and `room_members.bot_seed`, both `NULL`-able, and its own header says forward-compatibility is enforced in the application rather than by a `NOT NULL` that would have required inventing values |
| A **new index** (`0002`) | invisible to application code |
| A **loosened referential action** | `0004` changed `rooms.owner_user_id` from `ON DELETE RESTRICT` to `ON DELETE SET NULL`. The old code never depended on the restriction firing; it depended on it *not* firing |
| A **new function or a new table** | nothing old calls it |
| A **widened CHECK** — a constraint that admits strictly more values | every value the old code writes is still admitted |

### Changes the previous release does not tolerate

| Change | What breaks |
| --- | --- |
| A **narrowed CHECK** — a constraint that stops admitting a value the old code writes | every insert or update from the old write path is rejected by the constraint |
| A **dropped or renamed column** the old code selects or writes | the query errors; a rename is worse, because it errors only on the paths that use it |
| A **new `NOT NULL` column with no default** | every insert from the old code fails, because it does not know the column exists |
| **Data rewritten in place** to a vocabulary the old code does not use | the old code reads values it cannot map |

### The worked example, from this repository

`0003_bot_seat_recovery.sql` is a real irreversible migration and it is the clearest illustration of the rule. It:

1. dropped `room_members_bot_profile_allowed`, the `CHECK` that admitted the five legacy names `nit`, `tight-aggressive`, `loose-aggressive`, `calling-station`, `maniac`;
2. rewrote those values in place to the strategy profile ids they stood for;
3. re-added the constraint admitting the **twelve** `@prl/poker-ai` profile ids plus `unknown`.

Four of the five legacy names — every one except `calling-station`, which appears in both lists — are **no longer admitted by the constraint**. The release before `0003` wrote bot seats through a lossy mapping that produced exactly those five names, so an application rolled back across `0003` would have its bot-seat writes rejected by `room_members_bot_profile_allowed`. The migration's own header states the other half: the rewrite is information-preserving in one direction only, so *"a restore is the only way back to a row that literally said 'nit'."*

That reading comes from the migration file and the constraint it installs. It has not been exercised as a rollback drill, and nothing in this repository has ever rolled an application back across it.

### The practical rule

Before a release, ask of every migration in it: **can the previous image's code still read and write every table it touches?** If the answer is no, the release has no application-level rollback, and that must be known before it ships rather than discovered while it is failing.

---

## 6. The one case where you cannot roll back

**A release containing a migration that carries `-- prl:irreversible: <reason>`.**

The marker is not decoration; it is the file declaring that the previous application cannot run against the resulting schema. `migrate.mjs up` refuses to apply a pending migration containing a `DROP TABLE`/`SCHEMA`/`DATABASE`/`SEQUENCE`/`TYPE`/`DOMAIN`/`VIEW`, an `ALTER … DROP COLUMN`/`DROP CONSTRAINT`, a `TRUNCATE`, a `DELETE FROM`, or a `RENAME … TO`, unless the file says so with a real reason after the marker on its own line. So an irreversible migration is always a migration somebody wrote a sentence about.

For such a release:

- there is **no application rollback path**. Redeploying the previous digest gives you code that cannot serve;
- the reversal is a **restore from backup** — [`backup-restore.md`](backup-restore.md), [`disaster-recovery.md`](disaster-recovery.md) §5.2 — which reverts *all* data to the backup point, not just the schema, and loses everything written since;
- so it must be a **deliberate decision made before the release**, with the fix-forward plan written down, and not a discovery during an incident.

The way to avoid ever being here is the two-release rule ([`deployment.md`](deployment.md) §9): ship the additive half, roll the application onto it, ship the removal later. That is the entire reason the rule exists.

---

## 7. Destructive database changes are never automatic

An absolute rule, stated as a rule because it must survive pressure:

- **The pipeline never auto-runs a destructive database change.** `.github/workflows/release.yml` states this in the header of its production job, and `migrate.mjs up` enforces it on every run, in every environment.
- **Never run a destructive statement to clear an incident.** No deploy is urgent enough. `runbooks/README.md` rule 2 says the same thing to every on-call engineer.
- **Never weaken a security control to restore service** — not the CSP, not the rate limit, not the origin allowlist, not the session cookie attributes. A production process cannot even carry `RATE_LIMIT_RESET_TOKEN`: it refuses to boot with it, precisely so that this cannot be done under pressure.
- **A repair migration that deletes rows will hit the destructive gate.** That is the gate working. Write the reason, and have somebody else read it.

---

## 8. After a rollback

A rollback is not finished when the previous digest is running.

1. **Verify.** Both probes; process start time stable over five minutes; `prl_hands_started_total` and `prl_hands_completed_total` rising together; `pnpm run test:smoke --strict` against the deployed origin. Full sequence in [`runbooks/rollback.md`](runbooks/rollback.md).
2. **Confirm the schema is still ahead of the code and that this is fine.** `migrate.mjs status` on the deployed database tells you which release the schema belongs to; it will be the newer one, and it should stay that way.
3. **Do not roll the schema back to match.** See §4.
4. **Write down which digest is now running and why**, because the next person to deploy needs to know that `main` is ahead of production.
5. **Fix forward.** The rolled-back release is a defect with an owner, not a closed incident.

---

## 9. What is not proven

Stated plainly, because this repository enforces the rule on itself: **documentation is not proof of runtime behaviour.**

- **No rollback has ever been executed here.** There is no registry, no deploy target and no production environment in this repository, so the "redeploy the previous digest" step has never run anywhere.
- **The digest identity check and the promotion of a verified digest are both proven; what is not proven is that either survives a registry.** This bullet used to say a green attestation and a completed promotion did not exist, because the two defects staging found were fixed after that run and `staging up` had not been re-run. It has since been re-run: `deploy/staging/staging-verified.json` records `2026-08-22T18:55:36Z`, commit `b292b2ac234c`, `dirty: false`, all four checks true, and `staging promote` reporting promotable and byte-identical — see [`staging.md`](staging.md) §8 and [`staging-verification.md`](staging-verification.md). `staging promote` was separately measured refusing an unverified digest and refusing a mismatched one, printing both values. The residual is that those digests live in a **local BuildKit store and are not registry-attested**, so nothing here shows the same digest being pulled by a host that did not build it.
- **The `0003` rollback incompatibility in §5 is read from the migration file, not measured.**
- **The restore path *is* measured**, on 2026-08-22, end to end at 1.04 s for the development database, including authorisation checks against restored data — [`backup-restore.md`](backup-restore.md) §7. That is the one reversal in this system with real evidence behind it.
