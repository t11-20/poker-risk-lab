# Alerts

Every alert here names the metric it fires on, the threshold, **why that number and not another**, what a human should do first, and which runbook to open. An alert without those four things is a pager that trains people to ignore it.

Most series named below are exported by `apps/api/src/observability/metrics.ts`, and for those the rule is wrong if the name does not appear in a live scrape of `GET /metrics` — not the other way round. Three families are not, and each is grounded differently by `alerts:verify` check 3: `alertmanager_*` comes from Alertmanager's own exposition, `up` is synthesised by Prometheus per scrape, and `probe_*` is manufactured per scrape by the blackbox exporter as the result of a request it makes through the front door. A `probe_*` name that appears in no query result is the same defect as a `prl_*` name that appears in no scrape.

---

## The two-tier rule

There are exactly two severities, and the difference is not how bad it is. It is **whether a human has to be woken up**.

| Severity | Meaning | Delivery |
| --- | --- | --- |
| **page** | Learners are currently unable to use the product, or something is silently wrong with money-shaped state (chips, progress, hand history), or a security control has failed. Somebody is woken up. | Paging channel |
| **ticket** | Something is degrading, trending wrong, or has failed in a way that is contained. It is looked at during working hours. | Ticket queue |

A third tier was considered and rejected. "Warning" alerts that go to a channel nobody owns are how a team learns to scroll past the one that mattered.

Each tier carries **two transports**, not one, and a deployment may use either or both. See [Configuring the destinations](#configuring-the-destinations) below.

There is a third `severity` value — `heartbeat` — and it is deliberately **not** a third tier. Exactly one rule carries it, it is never an incident, and it is routed to a machine rather than to a person. [`Watchdog`](#watchdog--heartbeat) below is the whole of it, and the argument for why it is a separate destination rather than a `page` or a `ticket` is made there.

---

## One incident is one notification, and `continue: false` was never enough

The route tree enforces "a page must not also raise a ticket" for **one alert reaching two receivers**. It has nothing to say about **four alerts about one incident**, and until `inhibit_rules` existed there was nothing in this deployment that did.

Measured: one blocked event loop raises `EventLoopBlocked`, and because the process is not answering it also raises `DbPoolSaturated`, `HttpLatencyP99High` and `HttpLatencyP95Degraded` — **three pages and a ticket for one cause.** Worse than the count is which of them arrives: `DbPoolSaturated` admits the problem in its own description above — "a blocked process produces the same reading without the pool being busy at all" — and it opens the Postgres runbook. So of the three phones that ring, one is actively sending somebody to the wrong subsystem while the event loop is the thing that is stuck. Reproduced against a real Alertmanager with the four alerts posted at once: **four notifications before, one after.**

Inhibition is the mechanism and grouping is not. Grouping decides how notifications are *batched*; inhibition decides which alerts are *consequences* of another that is already firing. Only the second can say "the pool reading is downstream of the loop". `group_by` stays `['alertname']` for a specific reason: Alertmanager's default subject template renders the **group** labels, so grouping by severity would turn `[FIRING:1] EventLoopBlocked` into `[FIRING:2] page` and demote the alert names into the body — and `alerts:verify` asserts the alert name is in the subject precisely because that line is what a locked screen shows.

The five pairs, all in `alertmanager.template.yml`:

| Source | Suppresses | Because |
| --- | --- | --- |
| `EventLoopBlocked` | `DbPoolSaturated`, `HttpLatencyP99High`, `HttpLatencyP95Degraded` | one stalled single-threaded process, measured in three places |
| `ApiDown` | `ApiNotReady`, `ProcessRestartLoop`, `HttpErrorRateHigh`, both latency rules, `EventLoopBlocked`, `DbPoolSaturated` | every target is a reading *of* the process that is down |
| `RoomOwnershipFenced` | `RoomOwnershipRefused` | two halves of one ownership incident, same runbook; the fencing is the worse half |
| `AlertmanagerDown` | `AlertmanagerNotificationsFailing` | of course the notification counter is not moving |
| `TlsCertificateExpiryImminent` | `TlsCertificateExpiringSoon` | two thresholds on one number; the page carries the deadline |

**No `equal:` on any of them**, and that is a decision rather than an omission. `equal` requires the named labels to match, and Alertmanager treats a label present on one alert and absent on the other as *unequal*. Nearly every rule here is a `sum()` over the whole deployment and carries no `instance` at all, while a few read a bare gauge and do — so `equal: ['instance']` would match nothing and every inhibition would silently never apply, which is the same class of defect as a rule that cannot fire. Deployment-wide is also simply correct: `replicas: 1` is a correctness constraint (ADR 0001), so there is one process to talk about.

**What is deliberately never suppressed.** `Watchdog` appears in no target list and must never appear in one: its signal is its *arrival*, and an inhibition would create the one thing a dead man's switch forbids — a silence with a cause other than the deployment being dead. `RateLimitBans` is not suppressed either, because a ban is evidence about a caller and stays true whatever else is broken. Nor is `PublicOriginDown`, for the reason given in its own entry. And nothing suppresses `ApiDown` or `RoomOwnershipFenced`: an alert that can be silenced by a symptom of itself is an incident nobody is told about.

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
**Why "set once at boot" is load-bearing, and was not true:** `changes()` counts every difference between consecutive samples and cannot tell a restart from a rounding flip, so this whole rule rests on the series being flat. It was not. The gauge was bound with `setFrom(() => Math.floor(Date.now() / 1000 - process.uptime()))`, which re-derives one fixed instant on every scrape from a wall clock and a monotonic clock that drift apart, and floors the difference. Measured on the development machine: 1.11 ms of drift over 20 s of sampling; on a series whose phase happens to sit on a second boundary — one process in roughly a thousand, by the accident of when it started — `changes()` counted **32 transitions** over those same samples. Three is a page. **This rule fired with zero restarts.** The value is now computed once at construction and `set()`, which makes this the one gauge in `metrics.ts` deliberately not read at scrape time: it reports an instant in the past, not a state that can change. Guarded by `apps/api/test/observability-metrics.test.ts`.
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
avg_over_time(prl_worker_pool_queued[10m]) > scalar(max(prl_worker_pool_size)) * 3 / 2
```

**For:** 15m.
**Why a ticket and not a page:** the queue is bounded by design and a full queue answers `service_unavailable` immediately rather than degrading everyone (`apps/api/src/workers/pool.ts`). So a deep queue is Coach analyses being refused — bad, contained, and not an outage.
**Why the threshold is derived and not a number:** it was `> 4`, and on the hosts this actually runs on that is a state the gauge cannot reach. The queue is bounded at `size * QUEUE_SLOTS_PER_WORKER` — three slots per worker — and the pool size is `max(1, min(4, availableParallelism() - 1))` (`config.ts`). On a 1- or 2-vCPU host that is **one worker and three slots**, so `prl_worker_pool_queued` is capped at 3: every Coach analysis being refused, permanently, with an alert that could not say so. On a four-worker host the same constant was wrong in the other direction, firing at 4 of 12 slots. `* 3 / 2` is half the queue limit on whatever host this is — 1.5 of 3, or 6 of 12.
**Why `scalar()`:** `avg_over_time(...)` carries `job` and `instance`; `max(...)` carries none, and a binary operator between the two matches nothing at all. That would be the same defect in a new spelling — an expression that is always empty.
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
sum(increase(prl_hands_failed_total[10m])) > 0
```

**No `for:`, and that is the fix.** It was `rate(...[10m]) > 0` with `for: 10m`, and **the alert could not fire at all.** After a single step, `rate(x[10m])` and `increase(x[10m])` are non-zero only while the window still holds a sample from before the step and one from after it — 10m minus one scrape interval, or 9m45s at the 15 s interval this deployment scrapes on. A `for:` as long as the window asks the condition to hold for longer than it can. Reproduced across 101 evaluation points with `promtool test rules`: the alert never left `pending`, and the same expression with `for: 9m` fired at t=1770s. A single step is the *normal* input here, not an exotic one: `rooms/registry.ts` increments this counter once, by `abandoned.length`, when it reconciles the hands a restart interrupted. `SeatReleaseFailing` below had the right shape all along and is the model.
**Why zero tolerance:** a hand that starts and never settles is a table full of people whose chips are in an indeterminate state. There is no acceptable background rate, so there is no `for:` — the first failed hand is the alert. The `reason` label says which kind; `interrupted_by_restart` after a deploy is expected once and must not recur.
**Why the counter is primed:** `increase()` is computed only from samples inside its range, so a counter that appears mid-window at 3 has an increase of 0 — Prometheus does not assume a series began at zero before it was first scraped. Unprimed, the **first** failed hand, which is the whole of what a zero-tolerance page is for, was invisible. Same argument and same measurement as `RateLimitBans`. Both `reason` values are primed (`primeLabels` in `observability/metrics.ts`).
**First action:** identify the `reason`, then find the room and hand ids in the logs (they are logged; they are deliberately **not** metric labels). → [`runbooks/api-unhealthy.md`](runbooks/api-unhealthy.md), which lists this alert in its Detection table. It used to annotate [`runbooks/hidden-card-incident.md`](runbooks/hidden-card-incident.md), whose first instruction is to roll back to the last digest — which is a poor answer to the one benign cause this alert has.

### `HandCompletionGap` — ticket

```
sum(prl_hands_started_total)
  - sum(prl_hands_completed_total)
  - sum(prl_hands_failed_total)
  > sum(prl_rooms_live)
```

**For:** 30m.
**Why it exists at all:** `prl_hands_failed_total` only counts failures the code *recognised*. This rule catches hands that vanished for a reason nobody wrote a counter for, which is the failure mode that matters most and is hardest to anticipate.
**What the old expression actually measured.** `increase(started[1h]) - increase(completed[1h])` is (hands in flight now) minus (hands in flight an hour ago). That is a number healthy play produces: **six tables each holding a hand clear a threshold of 5**, and twenty tables measure 20 — reproduced against a real rule engine, firing and staying firing for an hour. And in the case this rule exists for — no hand ever completes — `prl_hands_completed_total` had never been incremented, so it was *absent* rather than zero, `A - absent` is the empty vector, and **the rule could not fire at the one moment it was written for.**
**Why the cumulative invariant instead.** `started = completed + failed + in flight`, always. A hand leaves the in-flight set only by settling (`handsCompleted`), by its room closing under it (`LiveRoom.close` counts `room_closed`) or by being reconciled after a restart (`interrupted_by_restart`). At most one hand is in flight per live room, so **`prl_rooms_live` is the exact upper bound on the legitimate difference** — and it is read at scrape time from the same render as the counters, so there is no skew between the two sides. Anything above it is unaccounted for. There is no threshold to pick out of the air.
**Why all three counters are primed:** the expression is a subtraction, and a subtraction against an absent series is empty. Priming is what makes the catastrophic case produce a number. `deploy/staging/observability/rule-tests/product-correctness.test.yml` keeps the unprimed case in the suite, showing the alert silent, so that removing the priming fails something.
**Why 30m:** a real difference does not heal, so waiting rules out any sampling artefact and costs nothing.
**Why a restart is safe:** all three counters reset together, and `interrupted_by_restart` counts hands from the *previous* process, so it can only make the difference more negative. It fails in the safe direction.
**First action:** → [`runbooks/api-unhealthy.md`](runbooks/api-unhealthy.md).

### `TableActorFailing` — page

```
sum(increase(prl_table_actor_failures_total[5m])) > 0
```

**For:** 10m.
**Why:** a bot seat that cannot produce an action stalls a table without producing an error anywhere a user-facing alert would see. The turn clock eventually folds it, so the symptom a learner reports is "the table went quiet", which is very hard to trace backwards.
**Why the threshold came down to zero.** It was `> 0.05/s` sustained for ten minutes — **thirty failures per ten minutes** — while this alert's own description is *one* stalled seat on a thirty-second action clock, which is two failures a minute. A permanently broken bot seat sat at a fifteenth of the bar and was silent for an hour. Zero is the honest number because every value classified `actor` in `observability/telemetry.ts` is an error path (a bot that could not decide, an action the engine refused, a turn timeout that could not be applied); there is no healthy background rate to sit above.
**Why the window is shorter than the `for:`.** What separates an incident from a hiccup here is not the height, it is that it does not stop — so the persistence lives in the `for:`. At least one failure in every five-minute window for ten consecutive minutes. One stray failure, or a burst of five that stops, is true for 4m45s and cannot reach ten minutes. Same spelling, same reason, as `RoomOwnershipRefused`.
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
sum(increase(prl_archive_failures_total[15m])) > 0
```

**No `for:`.** It was `rate(...[15m]) > 0` with `for: 15m` — the same dead arithmetic as `HandsFailing`, one tier down. After a single archive failure the condition is true for 14m45s and the `for:` asked for 15m, so the alert could not fire. `SeatReleaseFailing` is the shape it should always have had.
**Why a ticket for a data-loss signal:** play deliberately continues when an archive write fails — a database hiccup must not stop a hand in progress (`apps/api/src/rooms/registry.ts`). So nothing is broken *right now*; hand history is silently becoming incomplete, which is a data problem to fix today rather than tonight.
**First action:** → [`runbooks/db-saturation.md`](runbooks/db-saturation.md).

---

## Enrolment — the counter nothing was reading

`prl_seat_entitlement_refusals_total` is exported, primed on both of its reasons, and documented at length in `observability/metrics.ts`. Until these two rules it was read by **no rule at all**: an argued-about, primed, closed-label counter that nothing watched. It only moves on a deployment running `PRL_ENROLMENT_REQUIRED=enforced`; on an open instance it sits at zero forever, which is the correct reading and is exactly why it is primed.

The two `reason` values are two incidents and must not be summed. A single rule on the total would let the quiet one hide inside the loud one — a busy morning of refusals would fire, the operator would be told about the class list, and the chair nobody got back would be inside the number.

**Why both are tickets.** On an enforced deployment a refusal is the access control doing precisely what it was configured to do. Neither rule can tell "the class list is wrong" from "somebody who is not on the list tried a seat" — no identifier reaches a label here, on purpose — and the remedy for either is `pnpm run enrolments`, an operator CLI with no HTTP surface, run by a person. A page would wake somebody to be told that an access control refused access. Both open [`runbooks/seat-entitlement-refused.md`](runbooks/seat-entitlement-refused.md).

### `SeatEntitlementRefused` — ticket

```
sum(increase(prl_seat_entitlement_refusals_total{reason="not_entitled"}[10m])) > 5
```

**No `for:`.**
**Why a volume threshold and not zero:** one refusal is a visitor tapping a seat on an enforced instance, which is the product working. Six in ten minutes is a *group* of people who expected to be able to sit and could not, which is the shape of a cohort arriving on the morning of a class to a list that missed them. On that morning the useful latency is the ten-minute window itself — the difference is a class waiting or not — so there is no `for:` on top of it.
**First action:** the counter carries no learner, room or seat; those are in the log line beside it. Compare the cohort's roster against `enrolments list`. The API holds `SELECT` only on both enrolment tables and cannot enrol anybody, so the grant is a CLI run with `DATABASE_MIGRATION_URL`.

### `SeatNotRestored` — ticket

```
sum(increase(prl_seat_entitlement_refusals_total{reason="seat_not_restored"}[15m])) > 0
```

**No `for:`, and zero tolerance** — the `SeatReleaseFailing` shape, and the counter is already primed so the first occurrence is a rise from zero rather than a series appearing.
**Why it is worth a rule at all:** `metrics.ts` calls this the one refusal that can move **with nobody using the product**. It is counted when a room is re-opened after a restart and a chair recorded in `room_members` is not given back, because whoever was sitting in it is no longer entitled. No request fails, no learner is at a keyboard, and the chair is simply gone the next time they look. Nothing else in this file can see it.
**Why not a page:** an expiry or a revocation taking effect at the next restart rather than at the moment of the write is a legitimate outcome, and the correct response is to check whether an enrolment actually changed. If none did, the seat was lost to a bug rather than to a policy, and *that* is an incident — which is the first question the runbook asks.

---

## Security

### `AuthFailureSpike` — ticket

```
sum(increase(prl_auth_failures_total[5m])) > 20
```

**For:** 10m.
**Why:** distinguishes a broken client (one reason, one deploy boundary) from credential stuffing (sustained, mixed reasons). The `reason` label is a closed set of contract error codes.
**Why 20 in five minutes and not 5 a second.** The old threshold wanted **7,200 failed sign-ins an hour**. Two a second, sustained, was measured silent for a full hour. This is four a minute that does not stop for ten minutes; in a cohort of thirty that is one learner in seven failing every minute, which is not a stale tab.
**Why this one is deliberately not near zero.** It is the only rule in this section with a real background rate: `not_authenticated`, `session_expired` and `csrf_failed` all happen to honest users with a tab left open. It stays a ticket because at this threshold it will occasionally be a broken client after a deploy, and that is a working-hours question.
**First action:** correlate with `prl_rate_limit_events_total`. If bans are also rising, it is automated. → [`runbooks/automated-abuse.md`](runbooks/automated-abuse.md).

### `AuthzFailureSpike` — page

```
sum(increase(prl_authz_failures_total[5m])) > 5
```

**For:** 10m.
**Why this one pages and the previous one does not:** these are **authenticated** callers being refused a resource — `not_room_member`, `room_not_found_or_not_permitted`, `forbidden`. Legitimate use produces almost none of them, because the UI does not offer links to other people's rooms. A sustained rate is somebody walking room and hand ids, which is an attempt to read another learner's hidden information.
**Why 5 in five minutes and not 2 a second.** The old threshold wanted **120 refused room reads a minute**. An enumeration at one request a second — a shell loop with `curl` in it — produced 3,600 refusals in an hour and was measured silent for the whole of it. The rate limiter closes the other end: it bans a caller who ignores `Retry-After`, so anybody slow enough to stay unbanned sat under the old threshold, and the band in which this rule could fire at all was traffic `RateLimitBans` had already reported.
**What now pages that did not, and why that is acceptable at 3am.** Roughly one refused room read a minute, not stopping, for ten minutes. That is the traffic this rule names and the old number excluded. What still stays silent: five refusals in five minutes, and twenty in one burst followed by nothing — a learner following a dead link to a room they were removed from is true for 4m45s and cannot reach the ten-minute `for:`.
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
**First action:** → [`runbooks/automated-abuse.md`](runbooks/automated-abuse.md), with `AuthFailureSpike`. It used to annotate the WebSocket runbook, which is about socket origins and has nothing to say about a ban wave.

### `WebSocketRefusalSpike` — ticket

```
sum(increase(prl_websocket_refused_total{reason="bad_origin"}[5m])) > 0
```

**For:** 10m.
**Why zero.** The old threshold wanted about **300 bad-Origin refusals per ten minutes**; a hundred in ten minutes was measured silent. A browser at a configured origin never produces one of these, so there is nothing to sit above — and neither of this rule's two causes is *large*. Both are *continuous*: `PUBLIC_WEB_ORIGIN` wrong after a deploy refuses every learner for as long as it is wrong, and somebody probing keeps probing. So the number is zero and the persistence is in the `for:`, with a window shorter than it. What now fires that did not: three refusals spread across ten minutes. What still does not: one stray refusal from a scanner.
**Why the origin reason specifically:** the WebSocket `Origin` check is the *only* server-side defence on a socket handshake — browsers send cookies on cross-origin WebSocket connections and CORS does not apply. A stream of refusals on that reason is somebody trying, or a legitimate origin missing from `PUBLIC_WEB_ORIGIN` after a deploy. Both need eyes.

---

## Connection churn

### `WebSocketReconnectStorm` — ticket

```
sum(rate(prl_websocket_opened_total[5m])) * 60 > max(prl_websocket_connections) + 5
```

**For:** 10m.
**Why the baseline is the live connection count and not this deployment's recent past.** The old rule was `rate(opened[5m]) > 3 * rate(closed[1h])`, and it fired on healthy mornings *and* could not fire on the failure it names:

- After any quiet period the baseline is zero, and three times zero is zero. Measured: a class of thirty connecting after an overnight lull cleared it, on thirty sockets that each opened once and stayed open. Any deployment used by day and not by night trips it every morning, which is how a ticket queue is taught to be scrolled past.
- A genuine storm raises *both* counters, so the baseline rises with the signal. Thirty learners reconnecting every ten seconds is 3 opens/s against a bar of 9 — silent.
- And before any socket had ever closed, `prl_websocket_closed_total` did not exist, so the right-hand side was absent and the whole comparison was the empty vector.

**Why churn and not volume:** a storm is sockets opening far faster than the number of sockets actually standing. More than one open per live connection per minute is every learner's table re-establishing itself repeatedly. `prl_websocket_connections` is read at scrape time from the hub, so it is always present — which removes the empty-baseline failure as well. The `+ 5` is the floor that keeps a deployment with nobody connected from firing on a handful of opens. Thirty learners arriving at once is 0.1 opens/s against a bar of 0.58: silent.
**First action:** check the `code` label on `prl_websocket_closed_total`. A wall of 1006-equivalents is a network or proxy problem; a wall of `serverShuttingDown` is a restart loop. → [`runbooks/websocket-spike.md`](runbooks/websocket-spike.md).

### `WebSocketConnectionsHigh` — ticket

```
prl_websocket_connections > 67
```

**For:** 10m.
**Why 67 and where the number comes from:** it is 70% of **96**, the concurrent seated players at which one instance saturated in [`load-test.md`](load-test.md). **A capacity alert copied from another service is worse than none**, because it produces confident wrong numbers — so this one is derived from this deployment's own measurement and must be re-derived whenever that measurement is repeated.

It was a placeholder of 400 until the measurement existed, listed here so the substitution was a visible task rather than a forgotten one. That task is now done, which moves the obligation rather than removing it: if you re-run the saturation hunt, change this number and `deploy/staging/observability/alert-rules.yml` in the same commit.

**First action:** → [`runbooks/websocket-spike.md`](runbooks/websocket-spike.md). It annotated the worker-saturation runbook, which never mentioned it.

---

## The front door — the blind spot every other rule shares

Every rule above reads a series the API exports **about itself**, and Prometheus scrapes that series on the compose network. The proxy, TLS and the page server are all downstream of it, and the API's own healthcheck targets its own container. So a dead nginx, an expired certificate, unreadable TLS material or a stopped Next.js server left `up{job="prl-api"}` at 1, `prl_readiness_state` at 1, every counter flat, and **every alert in this document green while every learner saw a dead site.**

A rule on "requests stopped arriving" was the alternative and it is worse here: this is a teaching lab with a class of thirty, so a night with no requests is the healthy overnight state, and a rule that fires every night is a rule that gets silenced. A synthetic HTTPS request through the front door every 15 s has no such ambiguity. `prometheus.yml` runs it as the `prl-public-origin` job against a blackbox exporter, and its own comment records why the target is `proxy:8443` rather than the published port, and what is therefore still **not** covered: Docker's port publishing, the host firewall and public DNS.

Two labels do the triage: `instance` is the probed URL and `module` says which upstream was being reached. `learner_page_https` failing alone is the page server; both failing is the proxy, TLS or the host. All four open [`runbooks/public-origin-unreachable.md`](runbooks/public-origin-unreachable.md).

### `PublicOriginDown` — page

```
probe_success{job="prl-public-origin"} == 0
```

**For:** 2m.
**Why a page:** it is the only rule in this file that speaks for the learner rather than about a process. While it is true, the site is dark.
**Why two targets are two alerts and that is fine:** they carry different `module` labels, `group_by: ['alertname']` in `alertmanager.template.yml` delivers them as one notification, and the pair is itself the triage.
**Why nothing inhibits it, and it inhibits nothing.** This is the one place in the deployment where two pages for one incident is the right answer. `ApiDown` and this can both be true, and neither implies the other: the API can be down with `/` still served, and `/` can be dark with the API perfectly healthy. An alert added to close a blind spot must not be suppressible by a signal from inside the thing it is watching.

### `PublicOriginProbeDown` — ticket

```
absent(up{job="prl-public-origin"}) or up{job="prl-public-origin"} == 0
```

**For:** 10m.
**Why a ticket and not a page:** this does not say the site is down. It says **nobody can see whether it is**, which is a different fact with a different urgency. A page meaning "something might be wrong somewhere" is the kind that gets ignored.
**Why `absent()`:** a job whose targets have gone produces no `up` series at all, and `up == 0` over nothing is the empty vector. Without the first half, deleting the exporter from the compose file would silence this rule *and* the three it exists to cover for, and leave nothing to say so. Same reasoning, same spelling, as `ApiDown`.
**What is true while it is firing:** `PublicOriginDown` and both certificate rules cannot fire. Treat the origin as unmonitored since it started, and check the site by hand.

### `TlsCertificateExpiringSoon` — ticket

```
min(probe_ssl_earliest_cert_expiry{job="prl-public-origin"} > 0) - time() < 21 * 86400
```

**For:** 15m.
**Why 21 days:** `pnpm run staging status` already warns under fourteen days, but only when a person happens to run the command. Three weeks puts the alert ahead of that, so the first thing that speaks is the one that speaks on its own.
**Why `min()`:** both probed URLs are served by one nginx presenting one certificate. A `for:` on a two-element vector is two alerts about one expiry.
**Why `> 0` inside the `min()`, which is not cosmetic.** A **failed** probe reports `probe_ssl_earliest_cert_expiry 0`, and `0 - time()` is a large negative number. Without the filter, every outage would fire both certificate rules — claiming an expiry that has not happened and sending somebody to renew a certificate that is fine, in the middle of an incident about something else. Filtered, an outage leaves the minimum over an empty set, so nothing fires here and `PublicOriginDown` pages instead, which is the truth. The same filter is what stops one dead target dragging the minimum to zero while the other still handshakes. Both directions are asserted in `rule-tests/public-origin.test.yml`.
**What it measures:** the certificate the proxy actually presented on a real handshake, not a file on disk. It is the one a browser will see.

### `TlsCertificateExpiryImminent` — page

```
min(probe_ssl_earliest_cert_expiry{job="prl-public-origin"} > 0) - time() < 3 * 86400
```

**For:** 15m.
**Why a page for something three days away:** an expiry is an outage with a timetable. At a known minute every browser refuses the site and no request reaches any service that could report it. Three days is the last point at which a renewal needing anybody outside this deployment can still be started on a working day.
**Why it does not also raise a ticket:** under three days is also under twenty-one, so `TlsCertificateExpiringSoon` is true as well. It is suppressed by an `inhibit_rules` entry in `alertmanager.template.yml` rather than by the expression — at delivery is where "one incident, one notification" is decided, and the page is the one carrying the deadline.

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

**Why a restart clears it:** the gauge starts from process start, not from zero — a process that has never swept is as stale as it is old and no more. That makes the gauge reset on every restart, so it is only safe while a process that fails to reach its first sweep is something `ProcessRestartLoop` already pages for. The first sweep is at T+60s (`FIRST_SWEEP_DELAY_MS`), so three such processes fit inside that rule's fifteen-minute window. It was T+6h, and at T+6h the claim was false by a factor of seventy: a deployment redeployed every six hours swept nothing, ever, and this rule could not see it. The gauge still cannot tell you whether the PREVIOUS process swept.

**Why a ticket and not a page:** nothing is broken for anybody at 3 a.m., and there is nothing useful to do at 3 a.m. either. What is accumulating is rows that should have gone, and the fix — find out why the timer stopped, usually by restarting the process — is a working-hours job. It stops being one if it is still firing tomorrow, which the runbook says.

**First action:** → [`runbooks/retention-sweep-stalled.md`](runbooks/retention-sweep-stalled.md).

---

## Meta — alerts about the telemetry itself

### `MetricsCardinalityOverflow` — ticket

```
prl_metrics_cardinality_overflow == 1
```

**Why:** the registry caps series per metric and folds everything past the cap into one overflow series (`apps/api/src/observability/registry.ts`). That cap is a *net*, not the design — the design is that every label comes from a closed set. If it ever engages, some caller is passing an unbounded value, and the metric it engaged on has silently stopped being precise. This alert is how anyone finds out.
**First action:** → [`runbooks/metrics-cardinality-overflow.md`](runbooks/metrics-cardinality-overflow.md). It annotated `api-unhealthy.md`, which is about a process that is not answering — a different fault with a different first move.

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

**What they cannot report is both paths broken at once**, and no rule that reports by *arriving* can — the channel carrying the report is the channel that failed. That is what the next section is for.

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

## The dead man's switch

Every rule above this line reports a failure by arriving. That shared mechanism is also their shared blind spot, and the two rules above name it exactly: if nothing can be delivered, the news that nothing can be delivered cannot be delivered either. From inside this deployment, a silent Alertmanager and a genuinely quiet week are the same picture.

The rule below inverts the direction. It fires permanently, so its notification must keep arriving at a watcher **outside** this deployment, and the signal is not the notification — it is the **gap**. Nothing is wrong when a ping arrives. Something is very wrong when they stop, and the report is made by a service that did not depend on anything that broke.

### `Watchdog` — heartbeat

```
vector(1)
```

**No `for:`, no metric, no scrape.** `vector(1)` is always true, which is the point: a heartbeat conditional on anything at all would go quiet for reasons other than the one it is watching for, and a dead man's switch that has cried wolf once is given a longer grace period by the person it woke. Then it is decoration.

**Why `heartbeat` and not `page` or `ticket`.** The two-tier rule at the top of this file is about *whether a human is woken*. This alert is neither tier, because it is never an incident — it fires on a healthy Tuesday morning and it will fire for as long as this deployment runs. Sent to the pager, it would wake somebody every `PRL_ALERT_HEARTBEAT_INTERVAL`, forever, about nothing; sent to the ticket queue it would do the same thing more slowly and with the same ending. Both are the *fastest known way to make a channel unreadable*, which is the exact harm the two-tier rule exists to prevent, arriving from the inside. So it gets a third **destination**, and the word that matters is destination rather than tier: this route ends at a machine whose only job is to notice that the pings stopped.

**Where it goes.** `PRL_ALERT_HEARTBEAT_WEBHOOK_URL` — a Dead Man's Snitch, a healthchecks.io check, a PagerDuty or Grafana OnCall heartbeat integration. It is that service, not this one, that pages a person, and it does so **on absence**. There is no `email_configs` on the heartbeat receiver: every heartbeat destination worth having is an endpoint that counts pings, and the one destination it must never be is an inbox, because a message every twenty seconds is a subscription somebody mutes.

**Why `send_resolved: false`, uniquely.** This alert never resolves. If it ever did, that notification would be the last thing the watcher heard, and it would read as a clean shutdown rather than as the failure it is.

**The interval and the grace period.** `PRL_ALERT_HEARTBEAT_INTERVAL` is `20s` in the rehearsal so that a verification run can observe several arrivals and one detected silence in a couple of minutes. A deployment sets whatever its snitch expects, and the constraint is the same either way: the interval must be comfortably inside the watcher's grace period, because the watcher pages on the gap, and a grace period of one missed ping alarms on every deploy.

**What is proven and what is external.** `pnpm run alerts:verify` check 7 proves the emitting half completely — the rule fires, it routes to its own receiver and to **neither** human tier, the notifications keep arriving with measured gaps inside the deadline, and then Alertmanager is deliberately **stopped**, the silence is detected while Prometheus goes on reporting the same alerts firing to nobody, and the pings resume when it comes back. What cannot be proven here is the watching half, and no amount of code in this repository can prove it: a watcher on this host dies with the host it is watching. That is one URL, and `pnpm run alerts:preflight` refuses to let a release be promoted while it still names this machine — which is what stops the firing half from shipping alone.

**First action:** → [`runbooks/heartbeat-missing.md`](runbooks/heartbeat-missing.md). It is the only runbook here opened because an alert **stopped**.

---

## What is deliberately NOT alerted on

- **Memory and CPU absolute values.** They are exported (`prl_process_resident_memory_bytes`, `prl_process_cpu_seconds_total`) and they belong on a dashboard. As alerts they fire on the healthy behaviour of a garbage-collected runtime under load. The *consequences* — latency, event-loop delay, restarts — are what pages, and each has a rule above.
- **429 rate.** That is the limiter working. Only bans page a queue.
- **4xx rate in general.** That is the product refusing invalid input, which is the product working. The two 4xx classes that mean something have their own rules.
- **Anything derived from a metric label containing a user, session, room or hand id.** No such label exists, on purpose (`observability/metrics.ts`). Per-entity investigation happens in the logs, correlated by request id, where access and retention are governed.
- **Host disk.** Nothing here exports it, and the reason it is a *decision* rather than an omission is that the consequences all have rules already: Postgres refusing writes surfaces as `ApiNotReady` and `DbPoolSaturated`, a full disk stopping the archive surfaces as `ArchiveFailing`, and a container that cannot start surfaces as `ApiDown` and `ProcessRestartLoop`. What a disk alert buys over those is **lead time**, and lead time is exactly what this deployment cannot get from inside a container: the figure that matters is free space on the Docker host's filesystem, which the API cannot see and which a bind-mounted `statfs` would report for whatever layer it happened to land on. Getting it right means a node exporter on the host, which is a component and a scrape target this stack does not have. Stated here so it is a known cost — this deployment learns about a full disk from a consequence, minutes later than a host metric would have said it.
- **PostgreSQL itself.** There is no `postgres_exporter` and no rule on connection counts, replication lag, transaction age, autovacuum, bloat or checkpoint timing. The signal this deployment does have is `prl_db_probe_duration_seconds` — the readiness probe's `select 1` — and `DbPoolSaturated` reads it. That is deliberately an *inferred* signal and `alerts.md` says so above: it rises under pool exhaustion before anything fails, and it cannot distinguish pool wait from event-loop delay. What it cannot see at all is a database that is healthy for `select 1` and unhealthy for everything else: a table whose autovacuum has not run, a long-running transaction holding the xmin horizon, a replica that has fallen behind. Those are real production failures and this deployment would learn about them as latency. Adding the exporter is the fix; until then, `runbooks/db-saturation.md` is written to be read with `psql` open rather than with a dashboard.
- **Backup success and age — and this one is a gap, not a decision.** `pnpm run backup` exists, `runbooks/backup-restore.md` documents restoring from it, and **nothing alerts on whether it ran.** That is the same shape as the retention sweep before `prl_retention_sweep_age_seconds` existed, and this document already names why that shape is dangerous: a backup that stopped running and a week with nothing to restore look identical from every dashboard here, and the failure is discovered at the one moment it cannot be fixed. The exposure is stated rather than implied: the RPO is **24 hours**, so the worst case is a day of hand history, progress and enrolments. The mechanism that fits is the one already in this file — a **second dead man's switch**: the backup job pings a snitch on success, and the snitch pages on the absence of a ping, which is the only report that cannot be swallowed by the thing it is about. `Watchdog` proves the pattern works here end to end. This is tracked, it is not done, and nothing above should be read as covering it.

---

## Where these rules live now

Every rule above is also `deploy/staging/observability/alert-rules.yml`, which a real
Prometheus loads. This file is the reasoning — the threshold, why that number and not
another, what a human does first — and that file is the behaviour. They must not disagree,
and three checks make sure they cannot drift quietly (this said "two" while listing three):

- `pnpm run alerts:verify` compares the alert names and severities in the two files and
  fails on any difference, against a live Prometheus.
- `scripts/alert-delivery.test.mjs` makes the same comparison with no containers, so an
  edit to one file and not the other fails in the pull request rather than in a release
  rehearsal. It also drives the config renderer and the SMTP sink directly, because a
  protocol bug in the latter would otherwise surface six minutes into a verification run
  that had already stopped the staging API.
- `deploy/staging/observability/rule-tests/` runs the rules through Prometheus' own rule
  engine — `pnpm run alerts:unit`, one throwaway `promtool` container on the digest the
  overlay pins, touching nothing that is running. This is the check that would have caught
  the defects recorded above, and none of the three checks before it could: every one of
  those rules loaded cleanly, evaluated without error, and agreed with this document.

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

Each of the two human tiers takes a webhook, an email recipient, or both. Set the empty string to
drop one; a tier left with neither is refused before anything starts.

`PRL_ALERT_HEARTBEAT_WEBHOOK_URL` is the exception: it may not be empty. The reason is not
symmetry. Every other destination announces its own absence during the first incident, loudly and
via the person who was not woken — but a heartbeat with nowhere to go announces nothing, ever, to
nobody, and that is indistinguishable from a healthy month from every angle inside this deployment.

| Variable | Rehearsal default | What a deployment puts here |
| --- | --- | --- |
| `PRL_ALERT_PAGE_WEBHOOK_URL` | the local sink's `/page` | PagerDuty Events API v2, Opsgenie, a Slack relay |
| `PRL_ALERT_TICKET_WEBHOOK_URL` | the local sink's `/ticket` | the ticket queue's intake webhook |
| `PRL_ALERT_HEARTBEAT_WEBHOOK_URL` | the local sink's `/heartbeat` | the ping URL of a dead man's switch **outside** this deployment |
| `PRL_ALERT_HEARTBEAT_INTERVAL` | `20s` | how often the heartbeat repeats; must sit well inside the watcher's grace period |
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
  pager stops being read — or a heartbeat pointed at either of them, which is the same harm with a
  much sharper edge, since that destination would receive a notification about nothing every
  interval until somebody muted it;
- a heartbeat destination that is a placeholder or names this machine. This is the refusal with the
  least visible failure of any in the list: a rehearsal-default *pager* is found during the first
  incident by the person who was not woken, but a rehearsal-default *heartbeat* is found never —
  the rule keeps firing, Alertmanager keeps routing it correctly, and the ping keeps arriving at a
  URL on somebody's laptop;
- a heartbeat URL over plaintext `http` to an off-host watcher. A snitch's ping URL **is** its
  credential — the token is the path — so in the clear it can be read and replayed, and a dead
  man's switch somebody else can keep alive is a dead man's switch with the pin taped down;
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

## The acknowledged test page

```
pnpm run alerts:ack
pnpm run alerts:ack -- --within 10m --by ada@acme-poker.io --out ack.json
pnpm run alerts:ack -- --alertmanager https://alertmanager.internal:9093
```

Everything above this section stops one hop short of the only hop that matters. `alerts:verify`
proves the pipeline. `alerts:preflight` proves the destinations are ones a stranger would accept.
`--handshake` proves the relay takes this deployment's credentials. **None of them proves a person
read anything**, and none of them can: from inside a deployment, an email-to-SMS gateway
decommissioned last year is byte-for-byte indistinguishable from one somebody is holding.

`alerts:ack` asks the only question that distinguishes them. It posts a real alert to this
deployment's Alertmanager with `severity: page`, so it travels the real route tree to the real
paging receiver over the real transports — and then it waits for a human to type back a one-time
code.

- The code is generated fresh from `crypto.randomInt`, is single-use, and dies with the process.
- It travels as an alert **label**, so Alertmanager's default subject template puts it in the
  `Subject:` — the part a locked screen shows without being unlocked, which is the only part
  anybody reads at 3am — as well as in the webhook payload and the mail body.
- A wrong code is counted and the window keeps running, because the realistic wrong-code case is
  the very person this is meant to prove was reached, mistyping off a phone screen at night. There
  are **five** attempts, and then the run fails.

**If nobody answers inside `--within` (default five minutes) or inside five attempts, the command
exits non-zero** and names the three failures it distinguishes between — the page never arrived, it
arrived and nobody saw it, or it arrived and nobody answered — because each has a different fix and
only the middle one is a broken deployment.

### The claim this used to make, and why it is gone

This section used to say the code "exists nowhere except in the delivered notification", and that
**there is therefore no path to the code that does not go through the pager**. That was false, and
an adversarial review demonstrated it three ways:

- Alertmanager echoes the label back on an **unauthenticated** `GET /api/v2/alerts`;
- `--alertmanager` is a **caller-supplied URL**, so the caller always chooses an Alertmanager they
  can reach;
- and the command printed the delivered `Subject:` — which contains the code by construction,
  because the subject is what the assertion is about — **six lines above the sentence promising the
  code was not on the screen**.

Measured: a robot scraped the code off this command's own stdout and passed. Another pointed
`--alertmanager` at an Alertmanager it controlled, read `ack_code` out of its own POST body, typed
it into a pty, and passed with a record stamped `"attended": true`.

The claim has been **changed rather than patched**, because there is no construction that keeps a
secret from its own caller: the code must travel through Alertmanager for the test to mean
anything, Alertmanager holds it, and the process that mints it is the caller's.

Three things were fixed rather than re-described, and each had a measurement behind it:

- **The code is never printed on the passing path.** `redactCode` replaces it wherever it would
  appear in something about to be shown, so a rehearsal that displays a delivered subject renders
  it as `(······ page)`.
- **The attempts are capped at five.** There was no cap at all. Measured through a real pty:
  **~106,450 counted guesses per second**, which is ~383 million inside a `--within 1h` window
  against a 2^30 code space — better than a one-in-three chance of guessing it with nobody reading
  anything.
- **`rehearsal` is derived from where the page actually went**, not from this checkout's
  `PRL_ALERT_*` variables — which describe what this checkout *would* render and say nothing about
  the Alertmanager the run is pointed at. Measured: an all-defaults run announced *"this run pages
  NOBODY"* while relaying through `smtp.sendgrid.example:587`. It is now read from the targeted
  Alertmanager's own loaded configuration **and** from observing the page arrive at this process's
  own sinks carrying this run's code, both of which must hold; anything unreadable — a `url_file`,
  a PagerDuty receiver, a status endpoint that does not answer — makes the run REAL, and such a run
  is now refused rather than blessed.

### What a pass proves, stated as narrowly as it deserves

**Somebody was at a terminal, inside the window and inside five attempts, holding a code this run
generated and sent as a `severity: page` alert through the named Alertmanager.** That is a fact
with a timestamp, and it is the first fact of its kind this repository has been able to produce.

It is evidence a **cooperating** operator produces for themselves. It is **not an attestation
against a hostile one**, and it does not prove they read a page rather than reading the
Alertmanager API — see the section above for why no version of this command could.

It is **not a promise about 3am next Tuesday.** It says nothing about the holiday nobody put in the
rota, the phone face-down in another room, the gateway that is decommissioned three months from
now, or the second person who was never on the test. An acknowledgement measures one moment.
Treating it as a property of the on-call arrangement is the same error as treating a green test run
as a proof of correctness — so run it again whenever the paging destinations change, and keep the
rota somewhere that is not this repository.

### The rehearsal, and the fence around it

A run counts as a rehearsal only when **both** of two things hold, and neither of them is an
environment variable in this checkout. First, `GET /api/v2/status` on the **targeted** Alertmanager
must return a loaded configuration whose every email destination goes through this process's own
SMTP sink and whose every receiver uses only integrations this command can read. Second, the page
must then be **observed arriving** at this process's own webhook and SMTP sinks carrying this run's
code — a rehearsal that cannot be seen arriving is not a rehearsal. It fails closed: anything
unreadable makes the run REAL, because this test may refuse a rehearsal that was one and must never
bless a real page.

One thing that cannot be established is said out loud rather than assumed away: **Alertmanager
redacts webhook URLs in its own API**, returning `url: <secret>`, so this command cannot enumerate
them and cannot prove there is no second webhook destination beside its sink. The banner says that
instead of saying "pages NOBODY", which is what it used to say while relaying to a real smarthost.

In a rehearsal and *only* in a rehearsal, `PRL_ALERT_ACK_UNATTENDED=1` reads the code out of the
delivered notification instead of off a keyboard, which is how the passing path is exercised in
this repository's own captures. The fence is the point: with any real paging destination, unattended
mode is **refused outright**, because a green record produced without a person is a record that
lies. An unattended run is stamped `attended: false`, prints a banner saying it is not a rehearsal,
and must not be quoted as one. For the same reason an attended run refuses to read from anything
but a terminal — a pipe is a script, and a script is not a person.

---

## Verifying these rules

A rule that has never fired is a rule that has never been tested. Each of the following can be provoked deliberately:

| Rule | How to provoke it |
| --- | --- |
| `ApiNotReady`, `DbPoolSaturated` | `pnpm run test:drills --only postgres-outage`, `--only pool-exhaustion` |
| `EventLoopBlocked`, `WorkerPoolQueueDeep`, `AnalysisTimeouts` | `pnpm run test:drills --only slow-simulation`; `pnpm run test:load` at a concurrency past the measured saturation point |
| `HandsFailing`, `HandCompletionGap` | `pnpm run test:drills --only sigterm-mid-hand` |
| `WebSocketReconnectStorm` | `pnpm run test:drills --only ws-disconnect-mid-hand` |
| `RateLimitBans` | `pnpm run test:smoke --strict` (section 12 floods the guest limiter by design) |
| `MetricsCardinalityOverflow` | covered by a unit test that pushes a metric past the cap |
| `PublicOriginDown` | `docker compose ... stop proxy`, or point the probe at a target that is not there |
| `SeatEntitlementRefused`, `SeatNotRestored` | `PRL_ENROLMENT_REQUIRED=enforced` and a seat request from an account with no live enrolment |

Provoking a rule and watching it fire is the only evidence that it is wired correctly.

**And every rule whose expression was changed now has that evidence without a deployment.**
`pnpm run alerts:unit` runs `deploy/staging/observability/rule-tests/` through `promtool test
rules` — Prometheus' own rule engine, on the digest the overlay pins — and asserts each rule in
**both** directions: that it fires for the failure it is named after, and that it stays silent for
the healthy shape it must not fire on. Several of the cases in there are the reproduction of a
defect this document used to describe as working: `HandsFailing` sitting in `pending` forever,
`WorkerPoolQueueDeep` against a queue that is full and capped at 3, `HandCompletionGap` firing on
twenty healthy tables, `WebSocketReconnectStorm` firing on an ordinary morning and silent through
a real storm. Those cases are kept, pointed at the current expressions, so the fixes cannot quietly
come undone.

That has now been done, and what it proved is narrower than "these alerts work". `pnpm run
alerts:verify` brings up a real Prometheus and a real Alertmanager beside the staging stack
and establishes four things about **all thirty-five** rules — they load with no evaluation
error, they agree with this document, every `prl_*` series they name appears in a live scrape
of the API and every `alertmanager_*` series in a live scrape of Alertmanager, and every
expression executes — and delivery for **three** of them, one per destination.
`ApiDown` is provoked by stopping the API container: it goes pending, fires, reaches
Alertmanager, and is delivered to the paging tier and not the ticket tier, with the resolved
notification following when the API comes back. `RateLimitBans` is provoked by flooding the
limiter past its ban threshold, and must reach the ticket tier and not the pager. Together
those are the two-tier rule at the top of this file being enforced by configuration rather
than by prose, in both directions.

`Watchdog` is the third, and it is provoked by nothing, because it is always firing. What is
verified about it is the shape of a dead man's switch rather than the shape of an alert: that
the pings **keep arriving** on their own destination with measured gaps inside the deadline,
that not one of them reaches a human tier over either transport, and then — the check that
makes the mechanism real rather than decorative — that with Alertmanager deliberately
**stopped**, the absence is detected inside the grace period while Prometheus goes on
reporting the same alerts firing to nobody, and that the pings resume when it returns.

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

### The four limits, stated plainly

1. **Thirty-two rules have not been provoked.** Three of the thirty-five are — `ApiDown`,
   `RateLimitBans` and `Watchdog`. For the rest, loaded, agreed, grounded and evaluable is a
   great deal more than a markdown file, and a great deal less than tested. The table above
   is how to provoke each of them by hand.
2. **The last hop is narrower than it was, not gone.** It used to be the whole of "no human
   is paged": both receivers were a webhook sink and no real delivery protocol had ever been
   spoken. Three of the four bullets above now have a gate against them:
   `pnpm run alerts:preflight` refuses a placeholder or an unset credential and blocks a
   promotion on it, `--handshake` exercises a real credential against the configured relay, and
   `pnpm run alerts:ack` sends a **real page** and refuses to exit 0 unless somebody types back
   a one-time code — never printed on the passing path — inside the window and inside five
   attempts. What remains is two things rather than one, and the second was found by attacking
   it. The first is what an acknowledgement cannot be: a promise about the future. It records
   that *somebody acknowledged, once, at a known time, within a bounded window*, and says
   nothing about 3am next Tuesday, about the holiday nobody put in the calendar, or about the
   email-to-SMS gateway that is decommissioned three months from now. The second is that a pass
   is evidence a **cooperating** operator produces for themselves and **not an attestation
   against a hostile caller**: the code must travel through Alertmanager, Alertmanager echoes it
   back on an unauthenticated endpoint, and the caller both chooses the URL and owns the process
   that mints the code. Neither limit is a substitute for the rota. Run it before go-live and
   after any change to the paging destinations.
3. **The heartbeat is emitted here and watched elsewhere.** `Watchdog` closes the case
   `AlertmanagerNotificationsFailing` and `AlertmanagerDown` cannot report — both paths broken
   at once — and check 7 proves every part of it that lives on this side of the URL, including
   a real detected silence. The **watcher** is external by construction: a process on this host
   would die with the host it is watching. `alerts:preflight` refuses to promote a heartbeat URL
   that still names this machine, so the emitter cannot ship without one; whether the snitch at
   the other end is armed and pointed at somebody's phone is a fact about a service this
   repository does not hold an account with.
4. **Staging, not production.** These rules have never been evaluated against production
   data volumes, and several thresholds (`WebSocketConnectionsHigh`, `WorkerPoolQueueDeep`)
   are derived from a capacity measurement of one instance on a laptop.
