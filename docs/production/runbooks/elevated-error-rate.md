# Elevated error rate or latency

The service is up and answering, and answering wrongly or slowly.

---

## Symptoms

- 5xx responses above the background rate (which is effectively zero here).
- p99 latency above one second.
- Learners report intermittent failures rather than an outage.

## Detection

| Alert | Rule | Severity |
| --- | --- | --- |
| `HttpErrorRateHigh` | 5xx / total > 2% for 5 minutes | page |
| `HttpLatencyP99High` | p99 > 1 s for 10 minutes | page |
| `HttpLatencyP95Degraded` | p95 > 250 ms for 30 minutes | ticket |

**Start from the contract code, not the status code.** The status cannot distinguish the cases that matter — `not_room_member` and `room_full` are both 403, and only one of them is somebody enumerating rooms:

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_api_errors_total
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_http_requests_total
```

Then narrow to a route. The route label is the Fastify route *pattern*, so it groups cleanly:

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep 'prl_http_requests_total.*status="5xx"'
```

### Is it errors or is it latency? They are different incidents

| | Errors | Latency |
| --- | --- | --- |
| Signal | `prl_api_errors_total`, 5xx class | `prl_http_request_duration_seconds` |
| Usual cause | a code path failing, or a dependency refusing | queueing behind a shared resource |
| Where to look next | logs by request id | the four saturation metrics below |

For latency, check these four in order — each has its own runbook and they are mutually exclusive in practice:

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_event_loop_delay_p99_seconds|prl_db_probe_duration_seconds_bucket|prl_worker_pool_queued|prl_websocket_connections'
```

| Elevated | Go to |
| --- | --- |
| event-loop delay | [worker-saturation.md](worker-saturation.md) |
| db probe duration | [db-saturation.md](db-saturation.md) |
| worker pool queued | [worker-saturation.md](worker-saturation.md) |
| none of them | this runbook — it is the code, not a resource |

## Immediate containment

**If it started at a deploy, roll back.** Correlate `prl_process_start_time_seconds` with the onset. A rollback to a known digest is cheap and reversible; a forward fix under pressure is neither. → [rollback.md](rollback.md).

**If it is one route**, and that route is not load-bearing, disabling it contains the incident without taking the product down. Most routes here are load-bearing; the calculation endpoints are the realistic candidate, and they already degrade gracefully by refusing rather than queueing.

**If 4xx is what rose, not 5xx**, this may not be an incident at all. A spike in `invalid_request` is usually a client deploy. A spike in `not_authenticated` is a session or cookie problem. A spike in `rate_limited` is the limiter working. Confirm which before doing anything: **the reflex to "fix" a 4xx spike by relaxing a limit is how a rate limiter or an origin check gets disabled during an incident, and neither is ever the right move.**

## Diagnosis

### By error code

| Code rising | Almost always |
| --- | --- |
| `internal_error` | an unhandled path. Find it in the logs — it is logged at `error` with the route pattern |
| `service_unavailable` | the worker queue is full, or the database refused. Both are contained by design |
| `computation_timeout` | analyses exceeding `COACH_TIMEOUT_MS` → [worker-saturation.md](worker-saturation.md) |
| `not_authenticated` / `session_expired` | sessions invalidated, or cookies not arriving. Check whether the API restarted with a generated development secret |
| `csrf_failed` | a client that stopped sending `x-csrf-token`, or a cookie the browser now rejects after a scheme or domain change |
| `forbidden` / `not_room_member` | enumeration → [hidden-card-incident.md](hidden-card-incident.md) |
| `rate_limited` | the limiter working. Check `prl_rate_limit_events_total{kind="banned"}` for whether it is a script |
| `invalid_request` | a client and server that disagree about a schema — a half-completed deploy |

### From logs

Every failure logs with `apiErrorCode`, `frameworkStatus`, `method` and `routePattern`, at a level chosen by classification: `error` for 5xx and anything unrecognised, `warn` for expected refusals, `info` for validation.

```bash
kubectl logs <pod> --since=30m | grep '"level":50' | head -20                       # unexpected
kubectl logs <pod> --since=30m | grep '"msg":"request failed with an unexpected error"' | head
kubectl logs <pod> --since=30m | grep '"reqId":"<the id from the report>"'          # one learner's request
```

`requestId` in an error body, `x-request-id` on the response, and `reqId` in the log are the same value. That is the whole correlation story, and it is why a learner report is worth much more when it quotes the id.

### Latency with no saturation signal

If none of the four resources is elevated and p99 is still high, the remaining suspects are: a specific slow route (group the histogram by route), an external dependency (OIDC discovery and token exchange are the only outbound calls this service makes), or a response that has grown — the app pushes whole-state frames, so a larger table state costs more to serialise.

## Recovery

| Cause | Action |
| --- | --- |
| Bad deploy | [rollback.md](rollback.md) |
| Resource saturation | the matching runbook above; do not treat it here |
| One failing route | fix forward if trivial and well understood, otherwise roll back |
| External dependency | it should degrade, not fail. `oidc_not_configured` and the OIDC error codes exist so a provider outage refuses sign-in honestly rather than 500ing |
| Client mismatch | roll the client back, or ship the server change the client expects |

## Verification

```bash
# 1. The 5xx class has stopped, not merely slowed.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep 'status="5xx"'

# 2. The specific code that rose is flat again.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_api_errors_total

# 3. Latency is back inside its buckets.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_http_request_duration_seconds_bucket | head

# 4. Nothing is saturated.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_event_loop_delay_p99_seconds|prl_worker_pool_queued|prl_db_probe_duration_seconds_bucket' | head

# 5. Hands complete — the product working, not just the endpoints.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E 'prl_hands_(started|completed)_total'

# 6. End to end.
pnpm run test:smoke --strict
```

Take each measurement twice, a few minutes apart. A counter that has stopped rising and a counter that is merely rising slowly look identical in a single sample.

## Escalation

Escalate when:

- The error rate persists on the previous known-good digest. It is not the deploy, and the next suspects are the environment and the database.
- `internal_error` is rising and no log line explains it. An unhandled path in a server holding authoritative game state is a correctness risk, not only an availability one.
- Any error involves a hand that started and did not settle → [api-unhealthy.md](api-unhealthy.md), and treat chips as being in an uncertain state.
- `forbidden` or `not_room_member` is what rose → [hidden-card-incident.md](hidden-card-incident.md), at page severity.
