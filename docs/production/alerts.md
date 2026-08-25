# Alerts

Every alert here names the metric it fires on, the threshold, **why that number and not another**, what a human should do first, and which runbook to open. An alert without those four things is a pager that trains people to ignore it.

Series names are the ones exported by `apps/api/src/observability/metrics.ts`. If a name below does not appear in a live scrape of `GET /metrics`, the rule is wrong and must be fixed — not the other way round.

---

## The two-tier rule

There are exactly two severities, and the difference is not how bad it is. It is **whether a human has to be woken up**.

| Severity | Meaning | Delivery |
| --- | --- | --- |
| **page** | Learners are currently unable to use the product, or something is silently wrong with money-shaped state (chips, progress, hand history), or a security control has failed. Somebody is woken up. | Paging channel |
| **ticket** | Something is degrading, trending wrong, or has failed in a way that is contained. It is looked at during working hours. | Ticket queue |

A third tier was considered and rejected. "Warning" alerts that go to a channel nobody owns are how a team learns to scroll past the one that mattered.

---

## Why the thresholds fall on bucket boundaries

`prl_http_request_duration_seconds` uses the buckets `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`. Every latency threshold below is one of those numbers.

That is deliberate. `histogram_quantile` **interpolates within a bucket**, assuming observations are spread evenly across it — which they are not. If p99 is alerted at 400 ms and the surrounding buckets are 250 ms and 500 ms, the alert fires on an assumption rather than a count, and the true p99 could be anywhere in a 250 ms range. Putting the threshold on a boundary means the alert fires on a number that was actually counted.

The same reasoning applies to `prl_analysis_duration_seconds` (buckets `0.05 … 30`) and `prl_db_probe_duration_seconds` (buckets `0.001 … 10`).

---

## Availability

### `ApiDown` — page

```
absent(up{job="prl-api"}) or max_over_time(up{job="prl-api"}[2m]) == 0
```

**For:** 2m.
**Why 2m:** one missed scrape at a 15 s interval is a scrape problem; eight consecutive misses is the service. A shorter window pages on every deploy.
**First action:** confirm from outside the cluster that `/api/v1/health` is unreachable, then → [`runbooks/api-unhealthy.md`](runbooks/api-unhealthy.md).

### `ApiNotReady` — page

```
min_over_time(prl_readiness_state[5m]) == 0
```

**For:** 5m.
**Why 5m, not immediately:** `/ready` reports degraded whenever the database does not answer, and a brief blip during a Postgres failover is expected and self-healing — the load balancer has already stopped sending traffic, which is the mechanism working. Five continuous minutes of degraded means it is not healing.
**Note:** `prl_readiness_state` is a *gauge set by the probe*, so it only updates when `/ready` is called. If nothing calls `/ready`, this rule cannot fire — which is why `ApiDown` above is keyed on `up` and not on this.
**First action:** → [`runbooks/db-unavailable.md`](runbooks/db-unavailable.md).

### `ProcessRestartLoop` — page

```
changes(prl_process_start_time_seconds[15m]) >= 3
```

**Why a start *timestamp* and not a restart counter:** a counter held in the process that restarted resets to zero on exactly the event it is meant to record. `prl_process_start_time_seconds` is set once at boot; every change in it is a restart, and it survives the thing it measures.
**Why 3 in 15 minutes:** one restart is a deploy. Two is a deploy plus a rollback. Three is a crash loop.
**First action:** read the last 200 log lines before each restart — `uncaughtException` and `unhandledRejection` both log at `fatal` and then exit non-zero (`apps/api/src/server.ts`). → [`runbooks/api-unhealthy.md`](runbooks/api-unhealthy.md).

---

## Latency and errors

### `HttpErrorRateHigh` — page

```
sum(rate(prl_http_requests_total{status="5xx"}[5m]))
  / sum(rate(prl_http_requests_total[5m])) > 0.02
```

**For:** 5m.
**Why 2%:** a healthy run of this API serves essentially zero 5xx — every expected refusal is a 4xx with a contract error code. 2% is comfortably above scrape noise and far below "users notice", which is the window where an alert is useful rather than confirmatory.
**Why 5xx and not 4xx:** 4xx is the product working. A spike in `not_authenticated` is a broken client or a credential-stuffing run, and it has its own rules below.
**First action:** group `prl_api_errors_total` by `code` to find which failure it is, then correlate by `x-request-id` in the logs. → [`runbooks/elevated-error-rate.md`](runbooks/elevated-error-rate.md).

### `HttpLatencyP99High` — page

```
histogram_quantile(0.99, sum by (le) (rate(prl_http_request_duration_seconds_bucket[5m]))) > 1
```

**For:** 10m.
**Why 1 s:** it is a bucket boundary, and it is roughly two orders of magnitude above a healthy request here (JSON assembled from memory or one indexed query). A p99 of a full second means requests are queueing behind something — the event loop, the pool, or the worker pool — and the next three rules say which.
**Why 10m:** one slow minute during a cache-cold deploy is not an incident.
**First action:** check `prl_event_loop_delay_p99_seconds`, `prl_db_probe_duration_seconds` and `prl_worker_pool_queued` in that order. → [`runbooks/elevated-error-rate.md`](runbooks/elevated-error-rate.md).

### `HttpLatencyP95Degraded` — ticket

```
histogram_quantile(0.95, sum by (le) (rate(prl_http_request_duration_seconds_bucket[10m]))) > 0.25
```

**For:** 30m.
**Why 250 ms and a ticket:** a bucket boundary, and the level at which the app feels sluggish without being broken. Half an hour of it is a capacity or regression question for working hours, not a wake-up.

---

## Saturation — the four resources that can actually run out

These exist because "the API is slow" has four different causes here and they need four different responses.

### `EventLoopBlocked` — page

```
prl_event_loop_delay_p99_seconds > 0.25
```

**For:** 5m.
**Why the event loop has its own alert:** this process is single-threaded for everything except Monte Carlo. One synchronous stretch of work blocks *every* connected socket, every timer, and every turn clock at once — and it shows up as high latency on endpoints that have nothing to do with the cause. Without this metric the investigation starts in the wrong place.
**Why 250 ms:** the turn clock and the WebSocket heartbeat both operate on second-scale timers. A quarter-second p99 delay is not yet visible to a learner, and it is well above the tens of microseconds a healthy loop shows.
**First action:** → [`runbooks/worker-saturation.md`](runbooks/worker-saturation.md).

### `DbPoolSaturated` — page

```
histogram_quantile(0.95, sum by (le) (rate(prl_db_probe_duration_seconds_bucket[5m]))) > 0.5
```

**For:** 5m.
**What this actually measures:** `/ready` runs `select 1` — the cheapest possible query. When it becomes slow, the time is not in the query, it is in **waiting for a pooled connection**. That makes this the pool-exhaustion signal, and it rises *before* anything starts failing, which is the whole point.
**Why 500 ms:** a bucket boundary, and three orders of magnitude above the sub-millisecond a healthy probe takes. Nothing but queueing produces it.
**Honest limitation:** `postgres.js` exposes no pool-wait counter, so this is an inferred signal rather than a direct one. It is inferred from a real measurement, and the drill in `docs/production/runbooks/db-saturation.md` reproduces it deliberately so the inference is verified rather than assumed.
**First action:** → [`runbooks/db-saturation.md`](runbooks/db-saturation.md).

### `WorkerPoolQueueDeep` — ticket

```
avg_over_time(prl_worker_pool_queued[10m]) > 4
```

**For:** 15m.
**Why a ticket and not a page:** the queue is bounded by design and a full queue answers `service_unavailable` immediately rather than degrading everyone (`apps/api/src/workers/pool.ts`). So a deep queue is Coach analyses being refused — bad, contained, and not an outage.
**Why 4:** the pool defaults to `min(4, cores - 1)` threads with a queue of several slots per worker. A sustained depth of 4 means the pool is never draining.
**First action:** → [`runbooks/worker-saturation.md`](runbooks/worker-saturation.md).

### `AnalysisTimeouts` — ticket

```
sum(rate(prl_analysis_total{outcome="timeout"}[10m]))
  / sum(rate(prl_analysis_total[10m])) > 0.05
```

**For:** 15m.
**Why 5%:** the Coach has a wall-clock budget (`COACH_TIMEOUT_MS`, default 3 s) and abandoning a run is a designed outcome, not a failure. A few percent is the tail. One in twenty is the budget being wrong or the box being oversubscribed.

---

## Product correctness — the alerts unique to a poker table

A generic web service does not need these. This one does, because its state is chips.

### `HandsFailing` — page

```
sum(rate(prl_hands_failed_total[10m])) > 0
```

**For:** 10m.
**Why zero tolerance:** a hand that starts and never settles is a table full of people whose chips are in an indeterminate state. There is no acceptable background rate. The `reason` label says which kind — `interrupted_by_restart` after a deploy is expected once and should not recur.
**First action:** identify the `reason`, then find the room and hand ids in the logs (they are logged; they are deliberately **not** metric labels). → [`runbooks/hidden-card-incident.md`](runbooks/hidden-card-incident.md) if any hidden-state concern is involved, otherwise [`runbooks/api-unhealthy.md`](runbooks/api-unhealthy.md).

### `HandCompletionGap` — ticket

```
sum(increase(prl_hands_started_total[1h])) - sum(increase(prl_hands_completed_total[1h])) > 5
```

**Why a difference and not a ratio:** hands in flight at the edges of the window make the two counters legitimately differ by a small amount. A ratio hides that; a difference with a small absolute threshold does not.
**Why it exists at all:** `prl_hands_failed_total` only counts failures the code *recognised*. This rule catches hands that vanished for a reason nobody wrote a counter for, which is the failure mode that matters most and is hardest to anticipate.

### `TableActorFailing` — page

```
sum(rate(prl_table_actor_failures_total[10m])) > 0.05
```

**For:** 10m.
**Why:** a bot seat that cannot produce an action stalls a table without producing an error anywhere a user-facing alert would see. The turn clock eventually folds it, so the symptom a learner reports is "the table went quiet", which is very hard to trace backwards.
**First action:** the `reason` label is a closed set from the typed problem events; each value has a distinct cause. → [`runbooks/api-unhealthy.md`](runbooks/api-unhealthy.md).

### `ArchiveFailing` — ticket

```
sum(rate(prl_archive_failures_total[15m])) > 0
```

**For:** 15m.
**Why a ticket for a data-loss signal:** play deliberately continues when an archive write fails — a database hiccup must not stop a hand in progress (`apps/api/src/rooms/registry.ts`). So nothing is broken *right now*; hand history is silently becoming incomplete, which is a data problem to fix today rather than tonight.
**First action:** → [`runbooks/db-saturation.md`](runbooks/db-saturation.md).

---

## Security

### `AuthFailureSpike` — ticket

```
sum(rate(prl_auth_failures_total[5m])) > 5
```

**For:** 10m.
**Why:** distinguishes a broken client (one reason, one deploy boundary) from credential stuffing (sustained, mixed reasons). The `reason` label is a closed set of contract error codes.
**First action:** correlate with `prl_rate_limit_events_total`. If bans are also rising, it is automated.

### `AuthzFailureSpike` — page

```
sum(rate(prl_authz_failures_total[5m])) > 2
```

**For:** 10m.
**Why this one pages and the previous one does not:** these are **authenticated** callers being refused a resource — `not_room_member`, `room_not_found_or_not_permitted`, `forbidden`. Legitimate use produces almost none of them, because the UI does not offer links to other people's rooms. A sustained rate is somebody walking room and hand ids, which is an attempt to read another learner's hidden information.
**First action:** → [`runbooks/hidden-card-incident.md`](runbooks/hidden-card-incident.md).

### `RateLimitBans` — ticket

```
sum(increase(prl_rate_limit_events_total{kind="banned"}[15m])) > 0
```

**Why bans and not 429s:** a 429 is the limiter doing its job for an ordinary busy client. A **ban** means the caller went far past the limit while ignoring `Retry-After`, which is a script rather than a person.

### `WebSocketRefusalSpike` — ticket

```
sum(rate(prl_websocket_refused_total{reason="bad_origin"}[10m])) > 0.5
```

**Why the origin reason specifically:** the WebSocket `Origin` check is the *only* server-side defence on a socket handshake — browsers send cookies on cross-origin WebSocket connections and CORS does not apply. A stream of refusals on that reason is somebody trying, or a legitimate origin missing from `PUBLIC_WEB_ORIGIN` after a deploy. Both need eyes.

---

## Connection churn

### `WebSocketReconnectStorm` — ticket

```
sum(rate(prl_websocket_opened_total[5m])) > 3 * sum(rate(prl_websocket_closed_total[1h]))
```

**For:** 10m.
**Why a ratio against a longer baseline:** absolute connection rates vary with the hour; a reconnect *storm* is a rate far above this deployment's own recent normal. Clients reconnect automatically, so a storm looks healthy in every per-request metric while every learner's table is flickering.
**First action:** check the `code` label on `prl_websocket_closed_total`. A wall of 1006-equivalents is a network or proxy problem; a wall of `serverShuttingDown` is a restart loop. → [`runbooks/websocket-spike.md`](runbooks/websocket-spike.md).

### `WebSocketConnectionsHigh` — ticket

```
prl_websocket_connections > 67
```

**For:** 10m.
**Why 67 and where the number comes from:** it is 70% of **96**, the concurrent seated players at which one instance saturated in [`load-test.md`](load-test.md). **A capacity alert copied from another service is worse than none**, because it produces confident wrong numbers — so this one is derived from this deployment's own measurement and must be re-derived whenever that measurement is repeated.

It was a placeholder of 400 until the measurement existed, listed here so the substitution was a visible task rather than a forgotten one. That task is now done, which moves the obligation rather than removing it: if you re-run the saturation hunt, change this number and `deploy/staging/observability/alert-rules.yml` in the same commit.

---

## Meta — alerts about the telemetry itself

### `MetricsCardinalityOverflow` — ticket

```
prl_metrics_cardinality_overflow == 1
```

**Why:** the registry caps series per metric and folds everything past the cap into one overflow series (`apps/api/src/observability/registry.ts`). That cap is a *net*, not the design — the design is that every label comes from a closed set. If it ever engages, some caller is passing an unbounded value, and the metric it engaged on has silently stopped being precise. This alert is how anyone finds out.

### `ReadinessFlapping` — ticket

```
changes(prl_readiness_state[30m]) > 6
```

**Why:** readiness flapping in and out takes an instance in and out of the load balancer repeatedly, which is worse for learners than being cleanly out. It is usually a database that is marginal rather than down.

---

## What is deliberately NOT alerted on

- **Memory and CPU absolute values.** They are exported (`prl_process_resident_memory_bytes`, `prl_process_cpu_seconds_total`) and they belong on a dashboard. As alerts they fire on the healthy behaviour of a garbage-collected runtime under load. The *consequences* — latency, event-loop delay, restarts — are what pages, and each has a rule above.
- **429 rate.** That is the limiter working. Only bans page a queue.
- **4xx rate in general.** That is the product refusing invalid input, which is the product working. The two 4xx classes that mean something have their own rules.
- **Anything derived from a metric label containing a user, session, room or hand id.** No such label exists, on purpose (`observability/metrics.ts`). Per-entity investigation happens in the logs, correlated by request id, where access and retention are governed.

---

## Where these rules live now

Every rule above is also `deploy/staging/observability/alert-rules.yml`, which a real
Prometheus loads. This file is the reasoning — the threshold, why that number and not
another, what a human does first — and that file is the behaviour. They must not disagree,
and two checks make sure they cannot drift quietly:

- `pnpm run alerts:verify` compares the alert names and severities in the two files and
  fails on any difference, against a live Prometheus.
- `scripts/alert-delivery.test.mjs` makes the same comparison with no containers, so an
  edit to one file and not the other fails in the pull request rather than in a release
  rehearsal.

`docker-compose.observability.yml` is an **overlay** on the staging stack, not part of it:
`docker-compose.staging.yml` is a manifest of what production runs, and production gets its
monitoring from somewhere else. Bringing staging up does not bring Prometheus up.

---

## Verifying these rules

A rule that has never fired is a rule that has never been tested. Each of the following can be provoked deliberately:

| Rule | How to provoke it |
| --- | --- |
| `ApiNotReady`, `DbPoolSaturated` | `pnpm run test:drills --only postgres-outage`, `--only pool-exhaustion` |
| `EventLoopBlocked`, `WorkerPoolQueueDeep`, `AnalysisTimeouts` | `pnpm run test:drills --only slow-simulation`; `pnpm run test:load` at a concurrency past the measured saturation point |
| `HandsFailing`, `HandCompletionGap` | `pnpm run test:drills --only sigterm-mid-hand` |
| `WebSocketReconnectStorm` | `pnpm run test:drills --only websocket-disconnect` |
| `RateLimitBans` | `pnpm run test:smoke --strict` (section 12 floods the guest limiter by design) |
| `MetricsCardinalityOverflow` | covered by a unit test that pushes a metric past the cap |

Provoking a rule and watching it fire is the only evidence that it is wired correctly.

That has now been done, and what it proved is narrower than "these alerts work". `pnpm run
alerts:verify` brings up a real Prometheus and a real Alertmanager beside the staging stack
and establishes four things about **all twenty-two** rules — they load with no evaluation
error, they agree with this document, every `prl_*` series they name appears in a live
scrape, and every expression executes — and one thing about **one** of them: `ApiDown` was
provoked by stopping the API container, went pending, fired, reached Alertmanager, and was
delivered to a receiver, which then received the resolved notification when the API came
back. The notification arrived on the paging path and not the ticket path, which is the
two-tier rule at the top of this file being enforced by configuration rather than by prose.

The three limits on that, stated plainly:

1. **Twenty-one rules have not been provoked.** Loaded, agreed, grounded and evaluable is a
   great deal more than a markdown file, and a great deal less than tested. The table above
   is how to provoke each of them by hand.
2. **No human is reached.** Both receivers are a webhook sink that the verification script
   runs on this host. There is no PagerDuty account here and no ticket queue; production
   replaces two URLs in `alertmanager.yml` and changes nothing else. The hop that ends at
   somebody's phone at 3am is still unrehearsed.
3. **Staging, not production.** These rules have never been evaluated against production
   data volumes, and several thresholds (`WebSocketConnectionsHigh`, `WorkerPoolQueueDeep`)
   are derived from a capacity measurement of one instance on a laptop.
