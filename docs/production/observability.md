# Observability

What this service exposes, how to reach it, what it deliberately does not record, and how to tell whether the telemetry itself is working.

Three surfaces, and they answer different questions:

| Surface | Answers | Where |
| --- | --- | --- |
| **Metrics** | "Is it working, how fast, and what is running out?" — aggregate, cheap, alertable | `GET /metrics` |
| **Structured logs** | "What happened to *this* request / table / hand?" — per-event, correlated, retained under policy | stdout, JSON lines |
| **Probes** | "Should this instance receive traffic?" — a single yes/no for an orchestrator | `GET /api/v1/health`, `GET /api/v1/ready` |

The division is not cosmetic. Metrics carry no identifiers at all, so they can be scraped into a long-retention store with weak access control. Logs carry per-entity detail and are governed accordingly. Nothing that identifies a person, a table or a hand crosses from the second surface into the first.

---

## 1. Metrics

### Reaching them

```
GET /metrics
Authorization: Bearer $METRICS_TOKEN
```

Prometheus text exposition format, version 0.0.4. Every metric is prefixed `prl_`. Every duration is in **seconds** — a millisecond-valued source is divided at the call site and never stored under a `_seconds` name.

`METRICS_TOKEN` is a real secret: `loadConfig` applies the same length, entropy and placeholder checks it applies to the cookie-signing key.

**In production, if `METRICS_TOKEN` is unset the route is not registered at all** — a 404, exactly like every other absent path, rather than a 403. A 403 would confirm both that this software is running here and that somebody intended to expose metrics, which is free reconnaissance on a path every scanner tries. The cost is that an operator who forgets the token gets no metrics during an incident, so the server says so at boot:

```json
{"level":40,"warning":"METRICS_TOKEN is not set, so GET /metrics is not served. ...","msg":"configuration warning"}
```

Outside production the route is served without a token, so a developer's first encounter with a metric they just added is not a 404.

### Why there is no metrics library

`prom-client` was considered and rejected. The supply-chain policy (`docs/adr/0007-supply-chain-policy.md`) pins, hashes, IOC-scans and re-reviews every runtime dependency on every bump. What a metrics client buys is the text exposition format — a documented, stable, line-oriented serialisation that fits in one `render()` function — and a label registry, which is the part that actually needs care and which is implemented here with a property the library does not give for free: a hard cardinality cap.

`apps/api/src/observability/registry.ts` is the mechanism. `apps/api/src/observability/metrics.ts` is the policy.

### The cardinality rule, which is the only way a metrics endpoint takes a service down

It is never CPU. It is a label whose value comes from the request — a URL with an id in it, a user id, an error string — so the registry grows one time series per distinct value and never shrinks. That is an unbounded in-process memory leak reachable by an unauthenticated caller.

Three defences, in order:

1. **Every label comes from a closed set, chosen at the call site.** The route label is the Fastify *route pattern* (`/api/v1/rooms/:roomId`), never the URL, so its value set is exactly the set of declared routes. An unmatched request — a 404, a scanner walking a wordlist — gets the fixed string `unmatched`. Error codes come from the `ERROR_CODES` union in `@prl/contracts`. Methods come from a fixed list, because Node will parse an arbitrary token as a method on a raw socket. WebSocket close codes come from `WS_CLOSE`.
2. **The registry caps series per metric** and folds everything past the cap into a single `overflow_cardinality_capped` series. The metric stops being precise; it never stops being bounded.
3. **`prl_metrics_cardinality_overflow` goes to 1 when that happens**, and there is a ticket-severity alert on it. The cap is a net under rule 1, not a substitute for it, so engaging it is a defect worth investigating.

### What is exported

**HTTP**

| Series | Type | Labels | Question it answers |
| --- | --- | --- | --- |
| `prl_http_requests_total` | counter | `method`, `route`, `status` (class) | Are we serving errors, and on which route? |
| `prl_http_request_duration_seconds` | histogram | `method`, `route` | What is p50/p95/p99, and did this deploy move it? |
| `prl_api_errors_total` | counter | `code` | *Which* contract failure is it? |
| `prl_rate_limit_events_total` | counter | `kind` (`limited`, `banned`) | Is somebody being limited, and are they ignoring `Retry-After`? |
| `prl_auth_failures_total` | counter | `reason` | Are sign-ins failing? |
| `prl_authz_failures_total` | counter | `reason` | Is an authenticated caller being refused resources — i.e. enumerating? |

`status` is a class (`2xx`, `4xx`, `5xx`), not the exact code: the exact code multiplies the series count by roughly ten and the specific failure is already in `prl_api_errors_total` and in the log line. `prl_api_errors_total` is incremented in `sendApiError` rather than derived from the HTTP status, because the status cannot distinguish the cases that matter — `not_room_member` and `room_full` are both 403, and only one of them is somebody walking room ids.

**WebSockets**

| Series | Type | Labels |
| --- | --- | --- |
| `prl_websocket_connections` | gauge | — |
| `prl_websocket_opened_total` | counter | — |
| `prl_websocket_closed_total` | counter | `code` |
| `prl_websocket_refused_total` | counter | `reason` |
| `prl_websocket_frames_rejected_total` | counter | `reason` |

Opened against closed is the reconnect-churn signal. The refusal reasons matter individually: the `Origin` check is the *only* server-side defence on a socket handshake, because browsers send cookies on cross-origin WebSocket connections and CORS does not apply.

**Tables and hands**

| Series | Type | Labels |
| --- | --- | --- |
| `prl_rooms_live` | gauge | — |
| `prl_hands_started_total` | counter | — |
| `prl_hands_completed_total` | counter | — |
| `prl_hands_failed_total` | counter | `reason` |
| `prl_table_actor_failures_total` | counter | `reason` |
| `prl_archive_failures_total` | counter | — |

The gap between started and completed is the number that matters most in this application, because a hand that starts and never settles is a table of people whose chips are in an indeterminate state. `prl_hands_failed_total` counts the failures the code *recognised*; the alert on the started-minus-completed difference catches the ones nobody anticipated.

`prl_archive_failures_total` exists because play deliberately continues when an archive write fails — a database hiccup must not stop a hand in progress. Nothing else would ever reveal that hand history was silently becoming incomplete.

**Analysis and the worker pool**

| Series | Type | Labels |
| --- | --- | --- |
| `prl_analysis_duration_seconds` | histogram | `kind` |
| `prl_analysis_total` | counter | `kind`, `outcome` |
| `prl_worker_pool_size` / `_threads` / `_busy` / `_queued` | gauge | — |
| `prl_worker_tasks_total` | counter | `outcome` |

`prl_analysis_duration_seconds` measures **end to end including time queued**, which is the number a learner experiences. Utilisation is deliberately *not* exported as its own gauge: a ratio cannot be aggregated across processes, while the two counts it is derived from can.

**Database**

| Series | Type |
| --- | --- |
| `prl_db_probe_duration_seconds` | histogram |
| `prl_db_pool_max` | gauge |
| `prl_db_errors_total` | counter (`category`) |

**Read this before trusting the pool signal.** `postgres.js` keeps its pool state in closures and exposes no wait count, no queue depth and no in-flight count. Reaching into those internals would make this instrumentation break on a patch release, silently, in the direction of reporting a healthy pool.

So pool pressure is measured indirectly and honestly: `/ready` runs `select 1`, the cheapest query that exists, and the probe is timed. When every pooled connection is busy, that time is not spent in the query — it is spent **waiting for a connection**. A probe that took 0.4 ms and now takes 200 ms is pool exhaustion with no other symptom yet.

It is an inferred signal, not a direct one. `pnpm run test:drills --only pool-exhaustion` provokes the condition deliberately so the inference is verified rather than assumed.

**Process and readiness**

| Series | Type |
| --- | --- |
| `prl_process_start_time_seconds` | gauge |
| `prl_process_resident_memory_bytes` | gauge |
| `prl_process_heap_used_bytes` | gauge |
| `prl_process_cpu_seconds_total` | counter |
| `prl_event_loop_delay_seconds` / `_p99_seconds` / `_max_seconds` | gauge |
| `prl_readiness_state` | gauge |
| `prl_readiness_failures_total` | counter |
| `prl_metrics_series` | gauge |
| `prl_metrics_cardinality_overflow` | gauge |

**Why a start timestamp and not a restart counter:** a counter held in the process that restarted resets to zero on exactly the event it is meant to record. `time() - prl_process_start_time_seconds` is the uptime, and a drop in it is a restart — the only version of this that survives the thing it measures.

**Why the event loop gets three gauges:** this process is single-threaded for everything except Monte Carlo. One synchronous stretch of work blocks every connected socket, every timer and every turn clock at once, and surfaces as latency on endpoints unrelated to the cause. Without this metric the investigation starts in the wrong place every time. The source is Node's native `monitorEventLoopDelay`, which is a libuv-side histogram costing essentially nothing; it is **reset on every scrape**, so each sample describes the interval since the last one rather than all of history — otherwise a single stall at boot pins the maximum forever and the metric stops being actionable.

One correction is applied, and it matters. `monitorEventLoopDelay` does **not** report the excess delay its name suggests: on an otherwise idle loop it reports approximately the whole sampling interval, because libuv's poll phase blocks until the monitor's own timer is the next thing due. Measured on the machine this was written on, with nothing else running:

| resolution | idle mean | idle min |
| --- | --- | --- |
| 5 ms | 5.64 ms | 4.54 ms |
| 10 ms | 10.87 ms | 10.05 ms |
| 20 ms | 20.94 ms | 20.15 ms |

The offset is additive at the other end too: a deliberate 300 ms synchronous block at a 10 ms resolution reported a maximum of 310.9 ms. So the sampling interval is subtracted, clamped at zero. Uncorrected, a perfectly healthy process would have exported 20 ms of "event-loop delay" and an operator would have spent an incident chasing it — a metric that is confidently wrong is worse than one that is missing. After the correction an idle API process reports a mean of 0.88 ms, a p99 of 1.11 ms and a maximum of 1.76 ms. The cost is that real delays below the resolution clamp to zero, which is accepted: the alert fires at 250 ms and nobody acts on 8 ms.

### Gauges are read at scrape time, never mirrored

A gauge whose value already exists somewhere authoritative — `pool.stats()`, the hub's live-connection map, the registry's room count — is bound with `Gauge.setFrom()` or a `registry.onCollect()` hook and read when the scrape happens.

Mirroring it on change is the tempting alternative and it is wrong. A mirror drifts the first time an edit adds a code path that changes the source and forgets the metric, and **drift in a gauge is worse than no gauge**: it is a number an operator trusts during an incident and that is quietly wrong.

---

## 2. Structured logs

pino, JSON lines, on stdout. Every line carries a timestamp, a numeric severity, and — for anything request-scoped — a request id.

### Correlation

`request.id` is a `crypto.randomUUID()` generated per request. Fastify's default of adopting an inbound `request-id` header is **switched off** (`requestIdHeader: false`): a client-supplied id lets a caller forge log entries, collide two unrelated requests onto one id so a support investigation reads the wrong one, or push a megabyte of text into the logging pipeline.

The same id is echoed as `x-request-id`, listed in `Access-Control-Expose-Headers` so browser code can read it, and returned inside every error body as `requestId`. That is the whole correlation story: a learner quotes the id from an error, and it finds the exact request.

It is set in `onRequest`, not `onSend`, so it exists on responses that never reach a handler — a rejected preflight, a 429, a 404.

### What is in a request log line

The `req` serializer emits exactly `{ method, path, queryKeys, routePattern, clientKey }`. Note what is *not* there:

- **No URL.** The OIDC callback route carries an authorization code in its query string.
- **No query values.** The parameter *names* are logged, which is enough to know the provider came back with what it should have, while the code that could be exchanged for a session stays out.
- **No IP address.** `clientKey` is `HMAC-SHA256(secret, "client:" + address)` truncated to 16 hex characters.
- **No `remoteAddress`**, which is Fastify's default.

The `res` serializer emits `{ statusCode }`. The `err` serializer emits type, message, a stack capped at 4,000 characters, code, and `cause` followed three deep.

**Be honest about what the client key achieves.** It is pseudonymisation, not anonymisation: anyone holding the secret can confirm a guessed address. What it buys is that a leaked log file, a screenshot or a support ticket does not hand out a list of addresses, while the value stays stable enough to rate-limit on. It is keyed rather than a plain hash precisely because the IPv4 space is small enough to enumerate against an unkeyed one in seconds.

### Three overlapping redaction layers

1. **Serializers** replace whole objects with a chosen subset (above).
2. **A bounded recursive scrub** walks every other merged object and censors any key whose *name* looks sensitive — `SENSITIVE_KEY_PATTERN` plus an explicit set that includes `holecards`, `deck`, `deckorder`, `salt`, `commitmentsalt`, `displayname`, `csrf`. Bounded to depth 6, 400 nodes and 64 keys per object, so a cyclic or enormous object cannot turn one log line into a stall.
3. **pino's `redact` paths** run last over the serialized output.

Three layers is not paranoia. Layer 1 covers only keys somebody predicted, layer 2 covers only key *names* (not a token stuffed into a field called `note`), layer 3 covers only fixed paths. A leak has to get past all three. The censor string is the fixed literal `[redacted]`, so it is greppable.

### Never logged, ever

Hole cards, deck order, commitment salts, session tokens, CSRF tokens, OIDC codes and secrets, raw IP addresses, user-typed display names, database URLs. Hidden game state must not leave the server, and a log file is an exit — one this project closes explicitly rather than by convention.

### Severity, and why some things were moved

Severity is decided by `classifyThrown` in `apps/api/src/errors.ts`: `error` for 5xx and anything unrecognised, `info` for validation failures, `warn` for everything else. `logFailure` emits `{ err, apiErrorCode, frameworkStatus, method, routePattern }`.

Session rejections used to log at `debug` — invisible at the default `info` level — which meant a wave of forged or expired cookies was undetectable. The security-relevant paths (invalid signature, unknown session) now log at `warn`. Ordinary expiry stays at `debug`, because an expired cookie is normal traffic and logging it would drown the signal it is meant to reveal.

### Typed problem events

The room, table and bot layers report failures through one hook. It used to take a free-form prose string, which meant eleven distinct failure kinds — archive write, seat re-take, bot rehydration refusal, bot policy failure, rejected bot action, opponent-model refusal, turn-timeout application, engine rejection, subscriber throw — arrived as one untyped message that could not be counted or alerted on separately without parsing English.

The hook now carries a closed `event` discriminator, checked exhaustively by the compiler. The human message stays; the event is what `prl_table_actor_failures_total{reason}` is labelled with. This is the same shape `PoolWarning` already had and got right.

### The audit log

`prl.audit_log` had a complete, tested writer with **zero production call sites** — the security events its own doc comment named as examples were never recorded. It is now called for guest session creation, session revocation and sign-out, refused WebSocket upgrades, and rate-limit bans.

An audit write can never fail the request it describes: it is wrapped so a failed insert is logged and swallowed, the same rule the hand archive follows. An audit trail that can take down the thing it audits is worse than no audit trail.

---

## 3. Probes

| Endpoint | Answers from | Rate limited | Status |
| --- | --- | --- | --- |
| `GET /api/v1/health` | memory only | **exempt** | always 200 while the process is alive |
| `GET /api/v1/ready` | `select 1` against the pool | yes | 200 ready, 503 degraded |

**Liveness is exempt from the rate limit and readiness is not**, deliberately. Liveness exists so an orchestrator can tell whether this process is alive, and it must never fail for a reason unrelated to that. Readiness queries the database, so it has to be as limited as anything else that does. Keep `RATE_LIMIT_MAX` comfortably above the probe interval.

Health reports a coarse `version` and no build number or git SHA. That is a security decision, not an oversight: a precise version on an unauthenticated endpoint tells anyone which published vulnerabilities apply to this deployment. The metrics endpoint does not undo it.

`/ready` returning 503 while `/health` returns 200 is the correct behaviour during a database outage: the load balancer stops sending traffic without the orchestrator killing a process that is fine. `pnpm run test:drills --only postgres-outage` exercises exactly that.

---

## 4. Verifying the telemetry itself

Instrumentation that has never been observed working is a claim, not a control.

```bash
# The endpoint answers, is authenticated, and parses.
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" localhost:3001/metrics | head -40
curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/metrics          # 401 without the token

# Two consecutive scrapes of an idle process are byte-identical except for the
# gauges that are meant to move. Metrics are rendered in sorted name order
# precisely so this diff is meaningful.
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" localhost:3001/metrics > /tmp/a
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" localhost:3001/metrics > /tmp/b
diff /tmp/a /tmp/b

# Counters move when the thing they count happens.
curl -fsS localhost:3001/api/v1/health > /dev/null
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" localhost:3001/metrics | grep prl_http_requests_total

# Nothing hidden ever reaches the exposition. This must print nothing.
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" localhost:3001/metrics \
  | grep -Ei 'holecard|deck|salt|session|token|user_id|room_|hand_[0-9a-z]{8}'
```

The last one is also a unit test, asserted over a populated registry, because a grep is only as good as the moment somebody remembered to run it.

`pnpm run test:drills` provokes each alertable condition on purpose; `pnpm run test:load` scrapes `/metrics` before, during and after each concurrency level, so the metrics are read by something other than a human eye.

`pnpm run alerts:verify` closes the loop the other way. It brings a real Prometheus and Alertmanager up beside the staging stack (`docker-compose.observability.yml`, an overlay — the staging manifest has no monitoring in it, because production does not get its monitoring from this repository), asserts that every `prl_*` series the rules in [`alerts.md`](alerts.md) name appears in a live scrape of this exposition, and provokes `ApiDown` through to a receiver. That check is the one that catches a metric renamed here and not there: an alert on a series that stopped existing is syntactically perfect and permanently silent.

---

## 5. Known limits — what this does not give you

- **No distributed tracing.** One process, one database; a request id in the logs plus route-level histograms covers what a trace would. Adding OpenTelemetry would mean a dependency, an exporter, a collector and a sampling policy for a span depth of about two.
- **No log aggregation is included.** Lines go to stdout as JSON, which is what a container platform expects. Shipping, retention and access control are the deployment's job and are specified in `docs/production/deployment.md`.
- **Pool pressure is inferred**, not measured directly (see above).
- **Per-table detail is in logs, not metrics.** Room and hand ids are deliberately absent from every metric label. Investigating one table means a log search, not a query.
- **A single process holds live table state** (`docs/adr/0001-modular-monolith.md`). Metrics describe *this* instance; there is no cross-instance view of a table because a table never spans instances.
