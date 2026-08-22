# Database saturation

The database answers, slowly. Nothing is down; everything is queueing.

This is a different incident from [db-unavailable.md](db-unavailable.md) and the wrong response to one makes the other worse.

---

## Symptoms

- `/ready` still returns 200, but takes hundreds of milliseconds instead of under one.
- HTTP p99 rises across endpoints that have nothing in common except touching the database.
- `prl_archive_failures_total` starts incrementing while gameplay looks fine.
- Postgres reports `FATAL: too many connections`, or `pg_stat_activity` shows a wall of `active`.
- Everything recovers briefly, then degrades again.

## Detection

| Alert | Rule |
| --- | --- |
| `DbPoolSaturated` | p95 of `prl_db_probe_duration_seconds` > 0.5 s for 5 minutes |
| `ArchiveFailing` | `prl_archive_failures_total` rising for 15 minutes |

**What the probe metric actually measures, and why it is the right signal.** `/ready` runs `select 1` — the cheapest query that exists. When it becomes slow, the time is not in the query. It is in **waiting for a pooled connection**. A probe that took 0.4 ms and now takes 200 ms is pool exhaustion with no other symptom yet, which is exactly when you want to know.

It is an *inferred* signal. `postgres.js` keeps its pool state in closures and exposes no wait count or queue depth; reaching into those internals would break silently on a patch release, in the direction of reporting a healthy pool. So the inference is verified deliberately rather than assumed — `pnpm run test:drills --only pool-exhaustion` provokes the condition and asserts the metric moves.

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep -E 'prl_db_(probe_duration_seconds_bucket|pool_max|errors_total)|prl_archive_failures_total'
```

## Immediate containment

The goal is to reduce concurrent database work without taking the service down.

1. **Find and stop the specific thing consuming connections** before touching any limit:

```sql
select state, count(*)
  from pg_stat_activity
 where application_name = 'poker-risk-lab-api'
 group by state;

select pid, state, now() - query_start as duration, left(query, 120) as query
  from pg_stat_activity
 where application_name = 'poker-risk-lab-api'
   and state <> 'idle'
 order by duration desc
 limit 20;
```

2. **Cancel a genuinely stuck query**, not the connection:

```sql
select pg_cancel_backend(<pid>);           -- polite; try this first
select pg_terminate_backend(<pid>);        -- only if cancel does not work
```

3. **Do not raise `DATABASE_POOL_MAX`.** The instinct is exactly backwards. The pool bound is what turns a database overload into bounded queueing instead of `FATAL: too many connections`, which fails *every* query rather than delaying some. Raising it moves the failure from a place that degrades gracefully to a place that does not.

4. **Do not restart the API to "clear" the pool.** It drops every hand in progress and the pressure returns within seconds, because the cause is on the other side.

If the source is external load rather than a single query, shed it at the edge — rate limits, a queue, or fewer instances — never by relaxing the application's own limits.

## Diagnosis

**Idle in transaction is the classic cause.** A transaction a crashed handler never closed holds its connection and its locks indefinitely:

```sql
select pid, now() - state_change as idle_for, left(query, 120)
  from pg_stat_activity
 where state = 'idle in transaction'
 order by idle_for desc;
```

Every connection this application opens is created with `idle_in_transaction_session_timeout` set to twice `statement_timeout` (`apps/api/src/db.ts`), so Postgres kills these on its own. Finding one that survived means either the timeout is misconfigured or the connection did not come from this application — both are real findings.

**Lock contention:**

```sql
select blocked.pid as blocked_pid,
       blocking.pid as blocking_pid,
       left(blocked.query, 80) as blocked_query,
       left(blocking.query, 80) as blocking_query
  from pg_stat_activity blocked
  join pg_stat_activity blocking on blocking.pid = any(pg_blocking_pids(blocked.pid))
 where blocked.wait_event_type = 'Lock';
```

A migration running against a live table is the usual source. See [failed-migration.md](failed-migration.md).

**A slow query, or a plan that changed.** This one needs the `pg_stat_statements` extension,
which is not installed by default — `create extension pg_stat_statements;` plus the
`shared_preload_libraries` entry and a restart. It is worth having before you need it, because
the moment you need it is not the moment to restart the database:

```sql
select calls, mean_exec_time, total_exec_time, left(query, 120)
  from pg_stat_statements
 where query not like '%pg_stat%'
 order by total_exec_time desc
 limit 20;
```

`db/migrations/0002_indexes_and_constraints.sql` adds 28 explicitly declared indexes, and `verify-schema.mjs` counts 41 in total — the difference is the primary keys and unique constraints Postgres backs with an index of its own. The gate asserts the ones it names. If one is missing, the gate says so — run it. If they are all present and a query is still slow, the plan changed, and the usual cause is statistics after a bulk write:

```sql
select relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
  from pg_stat_user_tables
 where schemaname = 'prl'
 order by n_dead_tup desc;
```

**Connection budget arithmetic.** `DATABASE_POOL_MAX` is per process. Total demand is `pool_max × instances`, plus migrations, plus anything an operator has open. Compare against the server's `max_connections`. Over-provisioning the pool across instances is the most common way a deployment saturates a database that has plenty of CPU left.

**Statement timeout as a symptom.** Every connection carries a per-statement ceiling (`DATABASE_STATEMENT_TIMEOUT_MS`, default 5,000 ms). Queries cancelled by it appear as `prl_db_errors_total` and as errors in the log. That is the mechanism working — Postgres' own default is unlimited, and one accidental sequential scan over hand history would otherwise hold a pooled connection for as long as it took. A rise in cancellations tells you *which* query is the problem.

## Recovery

| Cause | Action |
| --- | --- |
| One stuck query or transaction | cancel it; then fix the code path that left it open |
| Missing index | add it as a forward migration with `CREATE INDEX CONCURRENTLY`; never a plain `CREATE INDEX` on a live table, which takes a write lock |
| Stale statistics | `ANALYZE prl.<table>;` and check autovacuum settings for that table |
| Bloat | `VACUUM (ANALYZE)`; a `VACUUM FULL` takes an exclusive lock and is an outage, so it is scheduled, never done under pressure |
| Genuine capacity | scale the database, or reduce `DATABASE_POOL_MAX × instances` to fit the server's budget |
| Migration holding locks | [failed-migration.md](failed-migration.md) |

## Verification

```bash
# 1. The probe is fast again — this is the signal that was saturated.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep prl_db_probe_duration_seconds_bucket
#    The 0.005 and 0.01 buckets should hold essentially every observation again.

# 2. Archive writes have stopped failing. This counter must be FLAT, not merely slower.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_archive_failures_total

# 3. HTTP latency has come back down.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep prl_http_request_duration_seconds_bucket | head

# 4. Schema and indexes are intact — especially if you added an index during the incident.
node --env-file-if-exists=.env apps/api/scripts/verify-schema.mjs
```

```sql
-- 5. Connections are idle again rather than active.
select state, count(*) from pg_stat_activity
 where application_name = 'poker-risk-lab-api' group by state;
```

Record the total increase in `prl_archive_failures_total` across the incident. Those hands were played correctly and their history was dropped; the loss is real, bounded, and worth stating rather than glossing.

## Escalation

Escalate when:

- Saturation returns within an hour of recovery. That is capacity, not an incident, and it needs a sizing decision.
- The connection budget is already correct and the database is still saturated at normal load — that is a regression, and the deploy that introduced it is the thing to find.
- Any query is slow because of a missing index that `verify-schema.mjs` claims is present. The schema and the database have diverged, which is more serious than the latency.
- You are contemplating `VACUUM FULL`, a schema change, or anything else that takes an exclusive lock on a live table. That is a planned outage, not an on-call action.
