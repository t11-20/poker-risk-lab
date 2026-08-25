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

Each tier carries **two transports**, not one, and a deployment may use either or both. See [Configuring the destinations](#configuring-the-destinations) below.

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

### `SeatReleaseFailing` — ticket

```
sum(increase(prl_seat_release_failures_total[15m])) > 0
```

**Why zero tolerance:** a seat is released when a hand *settles*, not when the player asks to leave.
If that write fails, nothing is waiting for it — play has already continued — so the in-memory table
frees the chair, the durable row keeps it, and the two disagree until the room is reopened. The
chair is unusable for the life of the process and **nothing retries**.

**Why a ticket and not a page:** nothing is broken right now. The table plays, the other seats work,
and no chips or hand history are at risk. One chair is unusable and will stay that way, which is a
working-hours problem rather than a wake-up.

**Why it is not `ArchiveFailing`:** it used to be. `seat-release` was not in the `ProblemEvent`
union, so the nearest available kind was `archive-write` — and an operator was told hand history was
being lost, with that runbook, when what had failed was freeing a chair.
`prl_api_errors_total{code="seat_taken"}` cannot substitute either: that is what this looks like
from outside and it is indistinguishable from two learners racing for the same chair, which is
ordinary.

**Why the counter is primed at zero:** a counter series is created by its first increment, and
`increase()` cannot see a rise from a value that was never scraped — so without priming, the first
stuck chair would be invisible to the rule that exists for it. Same reason as `RateLimitBans`.

**First action:** → [`runbooks/stuck-seat.md`](runbooks/stuck-seat.md).

### `RoomOwnershipFenced` — page

```
sum(increase(prl_room_fencings_total[10m])) > 0
```

**Why zero tolerance, and why this is a page:** a room being played is held in ONE process's memory
— the deck, the commitment salts and the pot have no column and never will — so
`prl.room_ownership` leases each room to exactly one API process. A *fencing* means this process
was serving a room and lost the lease, which is only possible if another process took it. For some
window bounded by the heartbeat interval, two processes were both authoritative for one room's
in-flight hand state.

That is not a near miss, it is the corruption itself. The hand held in the evicted process can
never settle; if the other process settled its own version of it, the stacks written to
`room_members` are not the ones anybody played for, and no error is raised anywhere. This meets the
page tier on both of its clauses at once: chips are in an uncertain state, and it does not heal —
the configuration that produced it (a second replica, a supervisor starting a replacement early)
is still there.

**How to tell the two causes apart:** the `reason` label. `fenced` means another process actively
took the room and the fix is the deployment. `lease_expired` means this process could not renew for
longer than the lease allows and stepped down of its own accord — a database or scheduling problem
here rather than a second process anywhere. Expect `ApiNotReady` or `DbPoolSaturated` alongside the
second one.

**Why it is not `HandsFailing`:** that fires too, because an evicted room's hand is abandoned. It
says a hand did not settle; this says *why*, and the why is the difference between a restart and a
deployment that is actively corrupting play.

**Why the counter is primed at zero:** `increase()` cannot see a rise from a series that was never
scraped, and the first fencing is the entire reason this rule exists. Both `reason` values are
primed, because the two are different incidents and neither may be the one that is missing.

**First action:** → [`runbooks/room-ownership-contended.md`](runbooks/room-ownership-contended.md).

### `RoomOwnershipRefused` — page

```
sum(increase(prl_room_ownership_refusals_total[5m])) > 0
```

**For:** 10m.
**What it means:** the guard working. A second process asked for a room this one is serving and was
refused with `503 room_owned_elsewhere`, so nothing was corrupted. But a refusal is never
transient by itself: a room is refused only while a live process holds and renews its lease, so a
sustained refusal rate means a deployment in which some fraction of learners are routed to a
process that cannot open the table they want. Behind a load balancer with two replicas that is
roughly half of them, indefinitely — learners cannot use the product, which is the page tier's
first clause.

**Why the window is shorter than the `for`:** a rolling deploy legitimately produces a few seconds
of refusals while the old container drains and the new one is already serving. `increase(...[5m])`
goes back to zero five minutes after the last refusal, so a burst cannot stay true for the ten
minutes the `for` requires. Only refusals that keep arriving fire this. A longer window than the
`for` would page on every deploy, which is how an alert gets muted.

**Why it is not counted as `prl_api_errors_total{code="room_owned_elsewhere"}`:** that counts the
requests refused rather than the refusals. One misconfigured process retrying a busy room produces
hundreds of the first from one of the second, and the two answer different questions — "how many
learners were affected" and "how many times did a process try to take a room it must not have".

**First action:** → [`runbooks/room-ownership-contended.md`](runbooks/room-ownership-contended.md).

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

**Why the counter is primed at zero:** a counter series is created by its first increment, and
`increase()` is computed only from samples inside its range — Prometheus does not assume a series
that appears mid-range began at zero. So the FIRST ban was invisible to this rule, which is the
one occurrence a zero-tolerance alert most needs to catch. Measured against staging: a real ban sat
in the counter at 1 and this rule stayed silent. `prl_rate_limit_events_total` now renders both
`kind` values at zero from boot (`primeLabels` in `observability/registry.ts`), so the 0 → 1 step
is visible. The same reasoning applies to `ArchiveFailing`, which is primed for the same reason.

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

## Data retention — the promise nothing else can see being broken

### `RetentionSweepStalled` — ticket

```
max(prl_retention_sweep_age_seconds) > 27000
```

**For:** 15m.

**Why this rule exists at all, and why it is not on the counter next to it.** The sweep also exports `prl_retention_rows_deleted_total{kind}`, and that counter is the wrong thing to alert on: on a deployment of any ordinary size most six-hour windows have no expired session, no abandoned sign-in and no sixty-day-old guest, so a flat counter is the **healthy** state. "Removed nothing" and "did not run" are the same flat line. Everything else about a dead sweep is equally invisible — no request fails, no latency moves, no error is logged after the one that killed it — which is precisely how this subsystem spent its early life with two sweeps that existed, were tested, and were called by nothing (`legal-review-requirements.md` §7). `docs/production/legal-register.md` §5 L5 gives the general shape: *"this is where a wrong answer is invisible: nothing fails, data simply persists."* So the sweep reports its own age and this rule reads that.

**Why 27,000 seconds (7½ hours):** the sweep runs every six hours, so this is one full interval plus a quarter of another — long enough that a slow sweep, a long first backlog or a scrape that lands awkwardly cannot trip it, short enough that a **single** missed tick is caught rather than a day of them. With `for: 15m` the page arrives a little under eight hours after the last successful sweep.

**Why an age and not a timestamp:** `time() - prl_..._timestamp_seconds` subtracts this process's clock from Prometheus's, and two hosts disagreeing about the time is not a retention failure. The API computes the difference against its own clock and exports the duration, so the rule compares a duration with a duration. It also survives this deployment's two-hour Prometheus retention, which no `increase()` over a six-hour window could.

**Why a restart clears it:** the gauge starts from process start, not from zero, because the first sweep is deliberately at T+6h rather than at boot — a process that has never swept is as stale as it is old and no more. A process restarting often enough to hide a dead timer this way is already `ProcessRestartLoop`.

**Why a ticket and not a page:** nothing is broken for anybody at 3 a.m., and there is nothing useful to do at 3 a.m. either. What is accumulating is rows that should have gone, and the fix — find out why the timer stopped, usually by restarting the process — is a working-hours job. It stops being one if it is still firing tomorrow, which the runbook says.

**First action:** → [`runbooks/retention-sweep-stalled.md`](runbooks/retention-sweep-stalled.md).

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

## The alerting system itself

Every rule above this section is delivered by Alertmanager. So the one failure none of them can report is Alertmanager failing to deliver — and that failure is not exotic: an expired provider key, a rotated SMTP password, a relay that starts answering `550` for this sender, or an intake URL that quietly began returning 404 all produce it. Each rule keeps evaluating and firing exactly as designed, Alertmanager keeps routing by severity exactly as designed, and nothing arrives.

Prometheus scrapes Alertmanager for this — the `prl-alertmanager` job in `prometheus.yml`. Until it existed, `alertmanager_notifications_failed_total` was exported by a container on the same network and read by nothing at all.

**Both of these are `page`, and the reason is asymmetry rather than severity.** A broken receiver is almost always *one* receiver: a ticket queue that has stopped accepting notifications can still be reported through the paging path, and a broken pager can still raise a ticket. Paging both means the report travels whichever path still works.

**What they cannot report is both paths broken at once**, and no rule can — the channel carrying the report is the channel that failed. That gap is closed only from outside the deployment, by a dead man's switch or a scheduled human check; [`runbooks/alerting-blind.md`](runbooks/alerting-blind.md) says so plainly rather than implying these two cover it.

### `AlertmanagerNotificationsFailing` — page

```
sum(increase(alertmanager_notifications_failed_total[15m])) > 0
```

**Why zero and not a rate:** one failed notification is one page that did not arrive. There is no number of undelivered pages that is acceptable, which is the same reasoning `ArchiveFailing` and `SeatReleaseFailing` use for their own thresholds. Alertmanager retries, so the notification may have been delivered in the end — the runbook's first step is to establish which integration failed and whether anything ultimately arrived, and the `integration` label answers the first half in one query.

### `AlertmanagerDown` — page

```
absent(up{job="prl-alertmanager"}) or max_over_time(up{job="prl-alertmanager"}[2m]) == 0
```

**Why:** while this is true, no alert of any severity reaches anybody — including this one. It is still worth having: Prometheus continues to evaluate it and shows it firing in its own UI, which is where it will be seen, and a deployment running more than one Alertmanager can lose one and be told. Treat a firing `AlertmanagerDown` as a report that the deployment has been unmonitored since it started, not as a report that one process needs restarting.

The `for: 2m` on top of `max_over_time(up[2m]) == 0` is the same shape as `ApiDown`, for the same reason: two minutes of missed scrapes have to accumulate before the inner condition can hold at all.

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
  rehearsal. It also drives the config renderer and the SMTP sink directly, because a
  protocol bug in the latter would otherwise surface six minutes into a verification run
  that had already stopped the staging API.

`docker-compose.observability.yml` is an **overlay** on the staging stack, not part of it:
`docker-compose.staging.yml` is a manifest of what production runs, and production gets its
monitoring from somewhere else. Bringing staging up does not bring Prometheus up.

---

## Configuring the destinations

`deploy/staging/observability/alertmanager.yml` is **not a tracked file**. It is rendered from
`alertmanager.template.yml` by `scripts/alert-delivery.mjs` before Alertmanager starts, the same
way that script already writes `metrics-token` from `PRL_STAGING_METRICS_TOKEN`. To bring the
overlay up by hand, render it first:

```
node scripts/alert-delivery.mjs --render-config
```

This exists because the previous arrangement — two `webhook_configs` URLs written into a tracked
file, and every document about it ending "production replaces two URLs" — makes the most
consequential setting in the alerting stack changeable only by editing a checkout. That is a
change made on a laptop, at the wrong moment, by somebody already having a bad night, and it
never appears in a diff. Alertmanager does not expand environment variables in its own
configuration, so the honest alternatives were a rendered template or a documented overlay; this
is the first, because a rendered file can be shown, diffed and archived.

Each tier takes a webhook, an email recipient, or both. Set the empty string to drop one; a tier
left with neither is refused before anything starts.

| Variable | Rehearsal default | What a deployment puts here |
| --- | --- | --- |
| `PRL_ALERT_PAGE_WEBHOOK_URL` | the local sink's `/page` | PagerDuty Events API v2, Opsgenie, a Slack relay |
| `PRL_ALERT_TICKET_WEBHOOK_URL` | the local sink's `/ticket` | the ticket queue's intake webhook |
| `PRL_ALERT_PAGE_EMAIL_TO` | `oncall@…invalid` | email-to-SMS, an email-to-PagerDuty address, a shared inbox |
| `PRL_ALERT_TICKET_EMAIL_TO` | `tickets@…invalid` | the ticket queue's intake address |
| `PRL_ALERT_SMTP_SMARTHOST` | the local SMTP sink | `host:port` of the relay that accepts the mail |
| `PRL_ALERT_EMAIL_FROM` | `alertmanager@…invalid` | envelope sender; relays reject mail from a domain they do not know |
| `PRL_ALERT_SMTP_HELLO` | `localhost` | the name given in `EHLO` |
| `PRL_ALERT_SMTP_REQUIRE_TLS` | `false` | **`true` anywhere the relay is not on the same host** |
| `PRL_ALERT_SMTP_USERNAME` | unset | enables SMTP AUTH |
| `PRL_ALERT_SMTP_PASSWORD` | unset | written to a 0600 file and read through `smtp_auth_password_file` |

The password is a file rather than a value in the configuration because the rendered
configuration is the artefact somebody pastes into a bug report, and a submission password in it
is a credential in a chat log.

### The values are checked before a release can be promoted

```
pnpm run alerts:preflight                 # placeholders, shapes, both tiers, credentials
pnpm run alerts:preflight -- --handshake   # and whether the relay accepts the credential today
```

`pnpm run staging promote` runs the first of those and refuses a promotion it fails. The reason it
exists is that `alerts:verify` **cannot** catch a placeholder, and the reason is structural rather
than an oversight: that script renders the destinations it is about to assert against, so it is
checking its own defaults — and its defaults are deliberately unroutable sinks on this host. It
passes hardest exactly when nothing has been configured. The preflight asks the opposite question:
are these values ones a stranger's mail relay and a stranger's pager would accept?

What it refuses, each of which produces an Alertmanager that starts, reports itself healthy, routes
by severity exactly as designed, and notifies nobody:

- a destination still holding a rehearsal default, a reserved documentation domain (`.invalid`,
  `.example`, `example.com`, `.test`), a name that resolves only on this machine
  (`host.docker.internal`, `localhost`, `127.0.0.1`), an unfilled `<…>` marker, or a
  come-back-to-this word;
- a URL that does not parse, an address with no dotted domain, a smarthost with no port;
- a severity tier that matches no route, or that routes to a receiver with nothing in it;
- a pager and a ticket queue that are the same address — the two-tier rule deleted, which is how a
  pager stops being read;
- an alert body crossing a network in the clear: `smtp_require_tls: false` to an off-host relay, or
  a plaintext `http://` webhook. `alerts:verify` only *warns* about that combination, correctly,
  because its own relay is a local sink with no certificate. A promotion is the other case;
- a username with no password, a password with no username, or a submission port (587, 465) with no
  credentials at all.

`--handshake` is opt-in, and a skipped handshake changes the summary line to
`PREFLIGHT PASSED — CREDENTIALS UNPROVEN` rather than passing quietly. When it runs it speaks TCP,
TLS, `EHLO`, `AUTH` and `QUIT` to the configured relay and nothing else — **no `MAIL FROM`, no
`RCPT TO`, no `DATA`** — so it can be run in a loop and can never put a message in anybody's inbox.
A `235` proves the relay accepts this deployment's credentials. It proves nothing about whether the
recipient address is watched, which is the next section's subject.

**Why email is a first-class transport here and not a fallback.** A great many teams page through
it — an email-to-SMS gateway, a provider's inbound address, a shared inbox with a phone rule on
it. It is also the only paging transport this repository can rehearse end to end without holding
an account somewhere, because SMTP is a protocol rather than an API key. That is what the next
section is about.

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
and establishes four things about **all twenty-eight** rules — they load with no evaluation
error, they agree with this document, every `prl_*` series they name appears in a live scrape
of the API and every `alertmanager_*` series in a live scrape of Alertmanager, and every
expression executes — and delivery for **two** of them, one per tier.
`ApiDown` is provoked by stopping the API container: it goes pending, fires, reaches
Alertmanager, and is delivered to the paging tier and not the ticket tier, with the resolved
notification following when the API comes back. `RateLimitBans` is provoked by flooding the
limiter past its ban threshold, and must reach the ticket tier and not the pager. Together
those are the two-tier rule at the top of this file being enforced by configuration rather
than by prose, in both directions.

### The email delivery is real, and here is exactly how far it goes

Both tiers are delivered over **two** transports, and every assertion above is made against
each. One is an HTTP webhook. The other is SMTP, and it is the one worth being precise about.

Alertmanager's `email_configs` speaks SMTP to a smarthost. `scripts/alert-delivery.mjs` runs
one: a few hundred bytes of `node:net` that greets with `220`, answers `EHLO` with a
multi-line `250`, takes `MAIL FROM` and `RCPT TO`, answers `DATA` with `354`, captures until
`\r\n.\r\n` and says `250`. That is a genuine SMTP transaction — Alertmanager's client cannot
tell it from a provider's relay — and what it captures is the RFC822 message a relay would
have been handed. The verification asserts on that message: the envelope recipient is the
address the tier's routing chose, the `Subject:` is Alertmanager's own `[FIRING:…]` or
`[RESOLVED]` line naming the alert, and the decoded body contains the alert name too.

**What that proves:** the email path is configured, reachable, addressed per tier, and
produces a real message containing the alert. Alertmanager opened a TCP connection, spoke the
protocol, and handed over ten kilobytes of RFC822 with `alertname = ApiDown` in it.

**What it does not prove, precisely:**

- **Not that a pager rings.** The SMTP server is a sink under this repository's control, not
  a relay that forwards anywhere. Nothing left this machine.
- **Not that a provider accepts this deployment's credentials.** The sink advertises neither
  `STARTTLS` nor `AUTH` and asks for nothing, deliberately: inventing an API key or a
  submission password would rehearse somebody else's account rather than this one. TLS
  negotiation, authentication and a provider's own acceptance rules are all untested.
- **Not that the address is one anybody watches.** An email-to-SMS gateway that was
  decommissioned last year looks identical to a working one from this end.
- **Not that a person is awake.** Nothing a repository can run proves that.

### The three limits, stated plainly

1. **Twenty-six rules have not been provoked.** Loaded, agreed, grounded and evaluable is a
   great deal more than a markdown file, and a great deal less than tested. The table above
   is how to provoke each of them by hand.
2. **The last hop is narrower than it was, not gone.** It used to be the whole of "no human
   is paged": both receivers were a webhook sink and no real delivery protocol had ever been
   spoken. Two of the four bullets above now have a gate against them:
   `pnpm run alerts:preflight` refuses a placeholder or an unset credential and blocks a
   promotion on it, and `--handshake` exercises a real credential against the configured relay.
   Two remain, and no gate in this repository can close them: **no address has been confirmed
   to be watched, and nobody has been woken.** An email-to-SMS gateway decommissioned last year
   accepts mail exactly like a working one. That is closed by a deployment sending itself a
   real test page and a person confirming it arrived — not by any command here.
3. **Staging, not production.** These rules have never been evaluated against production
   data volumes, and several thresholds (`WebSocketConnectionsHigh`, `WorkerPoolQueueDeep`)
   are derived from a capacity measurement of one instance on a laptop.
