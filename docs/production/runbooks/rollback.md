# Rollback

The decision to go back to the previous image digest, and how to do it.

Read [README.md](README.md) first. The policy behind every step here — why the schema does not come back with the application, what makes a release un-rollbackable — is [`../rollback.md`](../rollback.md). Do not improvise around it during an incident.

**One sentence to hold on to: the application rolls back, the schema does not, and rolling back restarts the API, which drops every hand in progress.**

---

## Symptoms

You are here because a release is live and wrong, not because something is merely unfamiliar. Any of:

- `/api/v1/ready` has returned 503 for more than 2 minutes since the roll settled.
- The error rate (`prl_api_errors_total`) or the 5xx share is materially above the pre-deploy baseline.
- Hand history has stopped being written. The product's central promise is that a hand is verifiable afterwards, so this is the silent failure that matters most.
- The smoke test fails against the production origin.
- The API crash-loops on a code fault (not on configuration — that is a fix-forward, see below).

**Not a rollback trigger:** WebSocket sessions closing with `1006` rather than `4503`. `1006` is a hard kill and indicts the orchestrator's grace period being at or below `SHUTDOWN_GRACE_MS`, not the release. Rolling back will reproduce it.

## Detection

```bash
# 1. Is it the release, or the database?
curl -sS -o /dev/null -w 'health %{http_code}\n' "$API/api/v1/health"
curl -sS -o /dev/null -w 'ready  %{http_code}\n' "$API/api/v1/ready"

# 2. What is actually failing, by contract code rather than by status?
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_api_errors_total|prl_hands_(started|completed|failed)_total|prl_archive_failures_total'

# 3. Which digest is serving, and which one was it before?
docker inspect <container> --format '{{.Image}}'
```

| health | ready | Reading |
| --- | --- | --- |
| 200 | 503 | the database, not the release → [db-unavailable.md](db-unavailable.md) |
| 200 | 200, errors high | the release is serving and getting it wrong → roll back |
| no answer | no answer | the new image is not starting → [failed-deployment.md](failed-deployment.md) first; exit 78 is configuration, not a rollback |

`prl_archive_failures_total` rising while play continues is the database degrading *history*, not gameplay → [db-saturation.md](db-saturation.md). Nothing is broken for the learner yet and a rollback would cost every live hand for no gain.

## Immediate containment

**Freeze the pipeline.** No further deploys of anything until this is resolved. A rollback racing a fix-forward is two versions in production and no way to say which one served a given request.

**Stop new work reaching the bad version** before you move any bytes: take the instance out of rotation at the load balancer, not by killing it. Readiness already does this automatically when the database is the cause.

**Capture evidence now**, because the restart destroys it:

```bash
kubectl logs <pod> | tail -500 > /tmp/prl-bad-release.log   # or: docker logs <container>
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" > /tmp/prl-bad-release-metrics.txt
```

**Announce it if there is a channel to announce on.** Hands in progress will be lost. That is not a footnote to the people playing them.

**Do not** rotate `SESSION_COOKIE_SECRET` as part of the rollback. A new secret invalidates every session cookie in existence and turns a bad release into a sign-out for everybody who was unaffected.

**Do not** touch the schema. There is no `down`, and reaching for one is how a bad release becomes lost data.

## Diagnosis

Three questions, in this order. Getting them out of order is how a rollback makes things worse.

### 1. Is the release actually the cause?

Roll back a release. Do not roll back a database problem, a saturated worker pool, or an orchestrator grace period. The table in *Detection* separates these; [api-unhealthy.md](api-unhealthy.md) separates them further.

**Configuration is a fix-forward, not a rollback.** Exit 78 means the process printed every configuration problem at once and never listened; the artefact is fine. Rolling back hides a misconfiguration that will recur on the next deploy. Fix the variable and redeploy — and never "temporarily" satisfy a refused check with a placeholder, because every one of those checks exists because a placeholder in production caused an incident once already.

### 2. Does the schema permit it?

**This is the question that decides whether a rollback is possible at all.** Ask it before touching a digest.

```bash
DATABASE_MIGRATION_URL="$ADMIN_URL" node apps/api/scripts/migrate.mjs status
```

List the migrations this release applied, then check each one for the marker:

```bash
grep -l 'prl:irreversible' db/migrations/*.sql
```

| Finding | Meaning |
| --- | --- |
| Every migration in the release is additive | the previous release runs against the newer schema. **Roll back.** |
| Any migration in the release carries `-- prl:irreversible: <reason>` | **there is no application rollback.** The previous code cannot serve against this schema. Go to §Recovery, "the release cannot be rolled back" |

The rules for what "additive" means concretely — a new nullable column is fine, a narrowed `CHECK` is not — are in [`../rollback.md`](../rollback.md) §5, with this repository's own worked example (`0003_bot_seat_recovery.sql`).

### 3. Is data involved?

If the bad release **wrote wrong rows**, rolling the application back stops the bleeding and does not repair anything. The repair is a forward migration, or a scratch restore and a merge: [`../disaster-recovery.md`](../disaster-recovery.md) §5.2, [backup-restore.md](backup-restore.md).

If the bad release **deleted** rows, the rollback is a restore and nothing else can recover them.

## Recovery

### The digest pair

The rollback target is both images together, taken from the **previous release's `release-manifest` artifact** (retention 90 days — that artifact *is* the rollback target). The `rollback-plan` job of each release prints the current digests and names the previous release tag, on every run, `if: always()`.

```bash
# From the previous release run's artifact:
node -e "const m=require('./release-manifest.json');
  for (const [n,i] of Object.entries(m.images)) console.log(n.padEnd(4), i.reference);
  console.log('commit', m.commit.sha);"
```

Roll **both** images, never one. `api` and `web` are one release: a paired fix that spans them — as the guest-bootstrap and Monte Carlo fixes did — leaves a state nothing has tested if only half moves.

### The procedure

1. **Record the digest you are leaving**, before you change anything. You will need it to reason about what was running when.
2. **Deploy the previous digest pair.** By digest, never by tag: `image: prl-api@sha256:…` resolves to exactly those bytes or to nothing.
3. **Leave the schema alone.** It stays ahead of the code. That is the design.
4. **Let the old process drain: `SIGTERM`, never `SIGKILL`.** The graceful path answers in-flight requests and sends every WebSocket a `4503 serverShuttingDown` close frame, so clients can say "the server is restarting" and reconnect. A `SIGKILL` gives every connected learner a `1006` that is indistinguishable from a lost network. Confirm `shutting down`, then `shutdown complete`, then exit 0.
5. **Expect live rooms to end.** Bot seats rehydrate from `room_members.bot_profile` and rooms reopen on next access; the in-memory hand does not come back.
6. **Verify** — the next section. A rollback is not finished when the container is up.

### If the release cannot be rolled back

A release containing an irreversible migration has no application rollback path. In descending order of preference:

1. **Fix forward.** Write the next migration and the next release. `0005`, never an edit to `0004`.
2. **Mitigate.** Disable the affected feature at the product level if it can be disabled without weakening a security control.
3. **Restore.** [backup-restore.md](backup-restore.md), accepting an RPO of 24 hours and the loss of everything written since the last archive. This is a data owner's decision, not an on-call engineer's.

That this situation exists at all should have been known before the release shipped: it is exactly what the `-- prl:irreversible:` marker is for.

## Verification

```bash
# 1. The bytes that are running are the ones you meant.
docker inspect <container> --format '{{.Image}}'    # must equal the previous manifest's digest

# 2. Both probes.
curl -fsS "$API/api/v1/health" && curl -fsS "$API/api/v1/ready"

# 3. Stable: take this twice, five minutes apart. It must NOT change.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_process_start_time_seconds

# 4. The symptom is gone: errors back to baseline, hands completing again.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_api_errors_total|prl_hands_(started|completed)_total'

# 5. The schema is still ahead of the code, and that is correct.
DATABASE_MIGRATION_URL="$ADMIN_URL" node apps/api/scripts/migrate.mjs status

# 6. End to end. This is the one that counts.
PRL_WEB_ORIGIN="$ORIGIN" node scripts/smoke-test.mjs --origin "$ORIGIN" --strict
```

Step 6 is the test. Steps 2 to 4 say the process is alive and quiet; the smoke test says a learner can get a session, join a room, play a hand to completion, and be correctly refused another learner's data.

Then write down, where the next deployer will see it: **which digest is now running, which commit it is from, and that `main` is ahead of production.**

## Escalation

Escalate when:

- The previous digest crash-loops too. That is not a release problem; the next suspects are the database and the environment → [api-unhealthy.md](api-unhealthy.md).
- The release contains an irreversible migration and the fix-forward is not immediate. A restore reverts *all* data to the backup point, and that is a decision with an owner.
- `prl_hands_failed_total` keeps rising after the rollback settles. Chips are in an uncertain state across multiple tables; treat it as a correctness incident, not an availability one.
- The bad release may have written wrong rows. The blast radius is not guessable — restore to scratch and diff ([`../disaster-recovery.md`](../disaster-recovery.md) §5.2).
- Any evidence that hidden state reached a client → [hidden-card-incident.md](hidden-card-incident.md), immediately, at page severity.
- You are considering a database change to make the rollback work. Stop. There is no deploy urgent enough.

Attach: both digests (leaving and arriving), the commit shas, the logs and `/metrics` snapshot captured during containment, the migration status before and after, and the smoke test output.

---

**One honest note about this runbook.** No rollback has ever been executed for this project: there is no registry, no deploy target and no production environment in this repository, so step 2 of the procedure has never run anywhere. The digest-identity machinery it depends on **is** proven — `staging promote` was measured refusing an unverified digest and refusing a mismatched one, printing both values — but the redeploy itself is a documented plan, not a rehearsed one. Treat the first real rollback as a drill and write down what it actually took.
