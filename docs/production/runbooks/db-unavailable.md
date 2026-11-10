# Database unavailable

PostgreSQL is not answering. The API process is fine.

---

## Symptoms

- `GET /api/v1/ready` returns **503** while `GET /api/v1/health` returns **200**.
- The instance leaves the load balancer without the orchestrator killing it.
- Learners can load pages but cannot sign in, join a room, or see history.
- Logs carry `readiness check failed` with `{"check":{"ok":false,"detail":"database did not answer"}}`.

**Healthy 200 with a degraded 503 is the design working, not a bug.** Liveness answers from memory and readiness runs `select 1`; the split exists precisely so a database outage takes an instance out of rotation without an orchestrator killing a process that is perfectly fine. `pnpm run test:drills --only postgres-outage` exercises exactly this.

## Detection

| Alert | Threshold |
| --- | --- |
| `ApiNotReady` | `min_over_time(prl_readiness_state[5m]) == 0`, `for: 5m` |
| `ReadinessFlapping` | more than 6 transitions in 30 minutes |

Five minutes, not immediately, because a brief blip during a failover is expected and self-healing — the load balancer has already stopped sending traffic, which is the mechanism doing its job.

```bash
curl -sS "$API/api/v1/ready" | jq .            # {"status":"degraded","checks":{"database":{"ok":false,...}}}
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep -E 'prl_readiness_(state|failures_total)|prl_db_(errors_total|probe_duration_seconds_count)'
```

The readiness body deliberately returns a **fixed string** rather than the driver's message: a driver error names hosts, users and database names. The real reason is in the log at the call site.

## Immediate containment

Nothing to do, and that is the point — readiness has already contained it.

Do **not**:

- Restart the API. It is not the faulty component, and restarting drops every hand in memory.
- Raise `DATABASE_POOL_MAX` to "push through". If the database is down this changes nothing; if it is overloaded this makes it worse. That is [db-saturation.md](db-saturation.md), a different situation with a different signature.
- Point `DATABASE_URL` at another database to restore service. A different database means a different dataset, and learners would silently see an empty or stale world.

Do:

- Confirm the blast radius. Gameplay in progress keeps working — table state is in memory and archive writes are non-blocking by design, so a live hand plays out and only its *history* is at risk. Sign-in, room creation, joining and history are the parts that are down.
- Announce that, if there is somewhere to announce it. "You can finish your hand, you cannot start a new session" is a much better message than silence.

## Diagnosis

Work outward from the API.

**1. Is it the database or the path to it?**

```bash
# From the API's own network position, not from a laptop.
psql "$DATABASE_URL" -c 'select 1'
pg_isready -d "$DATABASE_URL"
```

| Result | Meaning |
| --- | --- |
| connection refused | Postgres is down, or not listening where the URL says |
| timeout | network, firewall or security group between API and database |
| `FATAL: password authentication failed` | credential rotation went wrong → also [leaked-secret.md](leaked-secret.md) if unexpected |
| `FATAL: too many connections` | not an outage — [db-saturation.md](db-saturation.md) |
| `FATAL: the database system is starting up` | recovery in progress; wait, do not intervene |
| `select 1` succeeds | the API cannot reach what your shell can: DNS, TLS, or an in-process pool that has not recovered |

**2. Is the server up?**

```bash
docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' <postgres-container>
docker logs <postgres-container> --tail 100
```

Look for: out of disk (`could not extend file`, `No space left on device`), OOM kill, a crash-recovery loop, or a failover in progress.

**3. Disk, which is the most common cause of a Postgres that stops answering:**

```bash
df -h                                    # on the database host / volume
psql "$DATABASE_URL" -c "select pg_size_pretty(pg_database_size(current_database()))"
```

A full volume stops writes first and reads shortly after. This is the case where the fix is operational, not application-level.

**4. If the database is fine but the API still says degraded**, the in-process pool is the suspect. `postgres.js` reconnects on its own and `max_lifetime` is 1,800 s, so a pool that is permanently unhappy while the server is healthy is unusual and worth capturing before you clear it — that is a real finding. Restarting the API resolves it and destroys the evidence, so capture first.

## Recovery

Recovery is the database's, not the application's. In rough order of frequency:

| Cause | Action |
| --- | --- |
| Out of disk | free space or extend the volume, then let Postgres resume; check for runaway WAL |
| Process down | start it; read why it stopped before assuming it was spontaneous |
| Failover | wait for the new primary and confirm `DATABASE_URL` resolves to it |
| Credential rotation | fix the secret in the environment and restart the API — a rotated credential does not take effect on live connections, though `max_lifetime` recycles them within 30 minutes |
| Data corruption | stop. → [backup-restore.md](backup-restore.md). Do **not** run repair tooling against a primary without a backup you have verified |

The API needs no action for any of these. It reconnects on its own, `/ready` flips back to 200, and the load balancer returns the instance to rotation.

## Verification

```bash
# 1. Readiness recovers on its own, without an API restart.
curl -fsS "$API/api/v1/ready" | jq .

# 2. The probe is fast again, not merely successful. A slow-but-succeeding probe is
#    pool pressure, which is a different incident.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep -E 'prl_db_probe_duration_seconds_(sum|count)|prl_readiness_state'

# 3. Schema is intact — especially after any failover or restore.
node --env-file-if-exists=.env apps/api/scripts/verify-schema.mjs
node --env-file-if-exists=.env apps/api/scripts/migrate.mjs status

# 4. A real learner journey works end to end.
pnpm run test:smoke --strict
```

Then check what the outage cost in history rather than in availability:

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_archive_failures_total
```

Every increment is a hand whose archive write was dropped while play continued. Those hands are **not recoverable** — the write was best-effort by design. Record the count in the incident notes; it is the honest measure of data lost.

## Escalation

Escalate when:

- The outage exceeds the RTO in [`../disaster-recovery.md`](../disaster-recovery.md).
- There is any sign of corruption rather than unavailability — checksum failures, `invalid page header`, unexpected constraint violations after recovery. Go to [backup-restore.md](backup-restore.md) and stop touching the primary.
- `verify-schema.mjs` fails after recovery. The database came back as something other than what the application expects, and serving against it risks writing wrong rows.
- Recovery would need a restore. That is a decision with a defined RPO and a data-loss window, and it needs an owner, not an on-call engineer acting alone.
