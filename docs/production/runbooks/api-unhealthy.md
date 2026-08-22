# API unhealthy

The process is down, crash-looping, or alive but not doing its job.

Read [README.md](README.md) first — in particular, restarting this service **drops every hand in progress**, so "restart it" is a decision with a cost rather than a free first move.

---

## Symptoms

- `GET /api/v1/health` does not answer, or the connection is refused.
- Learners report the table frozen, or the page loading with no data.
- Hands start and never settle.
- The process comes back on its own, repeatedly.

## Detection

| Alert | What it means |
| --- | --- |
| `ApiDown` | no successful scrape for 2 minutes |
| `ProcessRestartLoop` | `prl_process_start_time_seconds` changed 3+ times in 15 minutes |
| `HandsFailing` | hands abandoned without settling |
| `TableActorFailing` | a seat actor cannot produce an action |

Distinguish the four cases immediately, because they have different causes:

```bash
curl -sS -o /dev/null -w 'health %{http_code}\n' "$API/api/v1/health"   # process alive?
curl -sS -o /dev/null -w 'ready  %{http_code}\n' "$API/api/v1/ready"    # database reachable?
```

| health | ready | Meaning | Go to |
| --- | --- | --- | --- |
| no answer | no answer | process is down or unreachable | this runbook, §Crash |
| 200 | 503 | process fine, database is not | [db-unavailable.md](db-unavailable.md) |
| 200 | 200 | process and database fine — the fault is in the tables | this runbook, §Alive but wrong |
| slow | slow | saturation, not failure | [worker-saturation.md](worker-saturation.md) |

`/health` answers from memory and is exempt from the rate limit, so a non-answer means the process is genuinely not serving. It is never a rate-limit artefact.

## Immediate containment

**If the process is down and a supervisor is restarting it:** let it. Do not attach a debugger to a process that is about to be replaced.

**If it is crash-looping**, stop the loop before investigating — a loop that restarts every few seconds destroys the evidence you need and drops a new set of hands each time:

1. Take the instance out of rotation at the load balancer (not by killing it).
2. Keep exactly one instance stopped and preserved for diagnosis, if there is more than one.

**If it is alive but wrong**, do not restart yet. An alive process holds the state that explains the fault, and restarting is the one action that guarantees you cannot find out what happened.

**Do not** raise limits, disable the rate limiter, or relax the CSP to "see if that helps". None of them can cause this class of failure and all of them make the incident worse.

## Diagnosis

### Crash

The process exits non-zero on `uncaughtException` and `unhandledRejection`, deliberately: a server holding authoritative game state must not carry on from a state nobody designed, because the next request would be served from half-updated state and the bug would become a wrong pot rather than a stack trace (`apps/api/src/server.ts`).

Both log at `fatal` (level 60) immediately before exiting:

```bash
# The last thing it said before dying.
kubectl logs <pod> --previous | tail -50           # or: docker logs <container> 2>&1 | tail -50
kubectl logs <pod> --previous | grep '"level":60'
```

Exit codes are chosen so the logs mean something:

| Code | Meaning |
| --- | --- |
| 78 | configuration invalid — `ConfigError` lists every problem on stderr; the process never listened |
| 1 at startup | `failed to start` — bind failure, or `listen EADDRINUSE` |
| 1 later | crash (`uncaught exception` / `unhandled rejection`), or a shutdown that exceeded its grace |
| 0 | clean shutdown |

**Exit 78 is the easy one and the most common after a deploy.** The process prints every configuration problem at once and refuses to start. Read the list; it names the variables. Common causes: `SESSION_COOKIE_SECRET` missing or a placeholder, `PUBLIC_WEB_ORIGIN` with a trailing slash or a path, `COOKIE_SECURE=false` in production, or `RATE_LIMIT_RESET_TOKEN` present in production (which is refused on purpose).

### Restart loop with no fatal line

If the process vanishes without logging `fatal`, it was killed from outside:

- **OOM.** Check the container's last state / `dmesg`. Correlate with `prl_process_resident_memory_bytes` on the previous run.
- **SIGKILL after a failed drain.** Look for `shutdown timed out; exiting hard`. That means `app.close()` did not finish inside `SHUTDOWN_GRACE_MS`; see [failed-deployment.md](failed-deployment.md).
- **Liveness probe killing a healthy-but-slow process.** If `/health` is timing out while the process is alive, the event loop is blocked — go to [worker-saturation.md](worker-saturation.md). Killing it does not fix that and does drop every hand.

### Alive but wrong

Both probes are 200 and the tables are still broken. Start from the counters, not the logs:

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_hands_(started|completed|failed)_total|prl_table_actor_failures_total|prl_archive_failures_total|prl_rooms_live|prl_websocket_connections'
```

- **`prl_hands_started_total` rising, `prl_hands_completed_total` flat.** Hands are dealt and never settle. The `reason` on `prl_hands_failed_total` says which recognised failure; if that counter is *also* flat, the hands are stuck rather than failing, which points at a seat that will not act — next bullet.
- **`prl_table_actor_failures_total` rising.** A seat actor cannot produce an action. The `reason` label is a closed set of typed problem events. `bot-rehydrate` means a seat could not be restored after a restart — the log line is `a bot seat could not be restored and will not act` and carries the reason; a row predating migration 0003 is a known, permanent case for that row and not an incident. `bot-policy`, `bot-action-rejected` and `engine-rejection` are code faults and need the log lines.
- **`prl_rooms_live` at 0 after a restart** is expected: rooms are rehydrated lazily on access, not eagerly at boot.
- **`prl_archive_failures_total` rising while play continues** is the database, not the tables. Go to [db-saturation.md](db-saturation.md); nothing is broken for the learner yet.

Then pull the matching log lines. Every table failure logs with room and seat identifiers — these are deliberately **not** metric labels, so this is where per-table detail lives:

```bash
kubectl logs <pod> | grep -E '"msg":"a bot seat could not be restored|"msg":"a hand could not be archived|"level":50'
```

## Recovery

**Configuration (exit 78).** Fix the variable, redeploy. Nothing else is wrong. Do not "temporarily" satisfy a refused check with a placeholder value — every one of those checks exists because a placeholder in production caused an incident once already.

**Crash from a code fault.** Roll back to the previous known-good digest — [rollback.md](rollback.md). Do not attempt a forward fix under pressure; the crash handler is doing exactly what it should and each restart costs another set of hands.

**Stuck tables with a healthy process.** A restart clears them, at the cost of the hands in progress. Prefer it only once you have captured the evidence, because after the restart the state that explains it is gone. Sequence:

1. Capture logs and a `/metrics` snapshot.
2. Announce, if there is a channel to announce on: hands in progress will be lost.
3. `SIGTERM`, never `SIGKILL`. The graceful path sends every socket a `serverShuttingDown` close frame, so clients reconnect cleanly instead of seeing an abrupt 1006 that is indistinguishable from a lost network. A `SIGKILL` turns a controlled interruption into a mystery for every connected learner.
4. Confirm the drain finished: `shutting down` then `shutdown complete`, and exit 0.

**Memory growth.** Restart to restore service, then treat the leak as a ticket with the `prl_process_heap_used_bytes` series from the failed run attached.

## Verification

```bash
# 1. Both probes.
curl -fsS "$API/api/v1/health" && curl -fsS "$API/api/v1/ready"

# 2. Uptime is increasing and stable — no further restarts.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_process_start_time_seconds
#    Take it twice, five minutes apart. The value must NOT change.

# 3. Hands complete again: started and completed rise together.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E 'prl_hands_(started|completed)_total'

# 4. End to end, against the deployed stack.
pnpm run test:smoke --strict
```

The smoke run is the one that counts. Two probes returning 200 says the process is alive; the smoke test says a learner can get a session, join a room, play, and be correctly refused another learner's data.

If the incident involved a restart with tables in play, also confirm the 12 AI Legend profiles rehydrated rather than falling back to `unknown` — a bot seat that cannot be restored is logged, and it does not act.

## Escalation

Escalate when:

- The process crash-loops on the previous known-good digest as well. That is not a deploy problem, and the next suspects are the database and the environment.
- `prl_hands_failed_total` keeps rising after a clean restart. Chips are in an uncertain state across multiple tables; treat it as a correctness incident, not an availability one.
- Any evidence that hidden state was exposed during the failure → [hidden-card-incident.md](hidden-card-incident.md) immediately, at page severity, regardless of whether service is restored.
- You are considering a database change to clear it. Stop and get a second person.

Attach to the escalation: the fatal log lines, the exit code, the `/metrics` snapshot from before the restart, the process start times, and the request ids from any learner reports.
