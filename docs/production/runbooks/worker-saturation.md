# Worker saturation and a blocked event loop

CPU-bound work is crowding out everything else. Two distinct failures share this runbook because they look identical from outside and have opposite fixes.

| | Blocked event loop | Saturated worker pool |
| --- | --- | --- |
| What is stuck | the single main thread | the Monte Carlo threads |
| Who notices | **everyone**, on every endpoint and every socket | people asking for Coach analysis |
| Signal | `prl_event_loop_delay_p99_seconds` | `prl_worker_pool_queued`, `prl_worker_pool_busy` |
| Severity | page | ticket |
| Wrong fix | adding workers | restarting the process |

**The distinction matters more than anything else in this file.** The main thread runs every request, every socket frame, every turn clock and every timer. Monte Carlo runs on worker threads specifically so it cannot block them. If the loop is blocked, the cause is on the main thread and more workers will not help — they will make it worse by adding message-passing work to the thread that is already stuck.

---

## Symptoms

- Latency rises on endpoints that share nothing — including `/health`, which answers from memory and should never be slow.
- Turn clocks fire late; learners are folded while they were still reading.
- WebSocket heartbeats miss and clients are dropped after two missed pings, producing a reconnect wave.
- Coach requests return `service_unavailable` or `computation_timeout`.
- The liveness probe times out and a supervisor kills a process that is not actually broken — which drops every hand in memory.

## Detection

| Alert | Rule | Severity |
| --- | --- | --- |
| `EventLoopBlocked` | `prl_event_loop_delay_p99_seconds > 0.25` for 5 minutes | page |
| `WorkerPoolQueueDeep` | `avg_over_time(prl_worker_pool_queued[10m]) > scalar(max(prl_worker_pool_size)) * 3 / 2` for 15 minutes | ticket |
| `AnalysisTimeouts` | > 5% of analyses time out over 10 minutes, `for: 15m` | ticket |

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_event_loop_delay|prl_worker_pool_(size|threads|busy|queued)|prl_analysis_total|prl_process_cpu_seconds_total'
```

Read them in this order:

1. `prl_event_loop_delay_p99_seconds` high → **main thread**. Go to §Blocked event loop.
2. Event loop fine, `prl_worker_pool_queued` high → **worker pool**. Go to §Saturated worker pool.
3. Both high → the pool is saturated *and* the main thread is doing something it should not; treat the loop first, because it affects everyone.

The event-loop metric has a known correction applied: Node's `monitorEventLoopDelay` reports the whole sampling interval rather than the excess delay, so the sampling interval is subtracted. An idle process reads under 1 ms. See [`../observability.md`](../observability.md) for the measurements. Anything above 250 ms is real.

## Immediate containment

**Blocked event loop.** Take the instance out of the load balancer if you have more than one — do not kill it. A blocked process is still holding live tables, and killing it converts "slow" into "every hand in progress is gone". If the liveness probe is about to kill it anyway, raising the probe's timeout buys diagnosis time and is the one probe change that is legitimate here.

**Saturated worker pool.** Nothing to contain. The queue is bounded by design and a full queue answers `service_unavailable` immediately rather than degrading everyone (`apps/api/src/workers/pool.ts`). Coach analyses are being refused; gameplay is unaffected. That is a designed failure mode working correctly, which is why it is a ticket.

Do **not** raise `MONTE_CARLO_WORKERS` above `cores - 1`. Equity work is CPU-bound; a pool larger than the machine does not add throughput, it adds context switching and starves the event loop — converting a contained ticket into a page.

## Diagnosis

### Blocked event loop

Nothing in the request path is supposed to block. The realistic causes, in order:

- **A large synchronous JSON serialisation.** This app pushes whole-state frames rather than deltas (`docs/adr/0009`), so an unusually large table state, or many sockets receiving one at the same instant, is the most plausible cause here.
- **A pure-core computation that escaped the worker pool.** The engine and maths packages are synchronous by design. Anything expensive from them must go through the pool; a call site that does not is a real defect and the highest-value thing to find.
- **Garbage collection under memory pressure.** Correlate with `prl_process_heap_used_bytes` and `prl_process_resident_memory_bytes`. Sawtooth growth with rising loop delay is GC.
- **A synchronous filesystem or crypto call on a hot path.**

```bash
# Correlate: does the delay track request volume, socket count, or memory?
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_event_loop_delay_max_seconds|prl_websocket_connections|prl_process_heap_used_bytes|prl_rooms_live'
```

If it reproduces, `node --cpu-prof` against a non-serving instance names the function. Use the load harness to reproduce it rather than experimenting in production:

```bash
pnpm run test:load --json          # ramps concurrency and scrapes /metrics at each level
```

`prl_event_loop_delay_max_seconds` is the one to watch: the mean hides a single 2-second stall, and a single 2-second stall is what a learner experiences as the table freezing.

### Saturated worker pool

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_worker_pool_(size|threads|busy|queued)|prl_worker_tasks_total|prl_analysis_(duration|total)'
```

| Pattern | Meaning |
| --- | --- |
| `busy` == `size`, `queued` high | genuinely at capacity — demand exceeds the box |
| `busy` < `size`, `queued` high | the pool is not dispatching; a defect, not capacity |
| `threads` < `size` | threads have died and not respawned — check for `worker-exit` warnings |
| `analysis_total{outcome="timeout"}` rising, `queued` low | individual analyses are too slow, not queueing — the sample count or `COACH_TIMEOUT_MS` is wrong |
| `analysis_total{outcome="rejected"}` rising | the queue is full and refusing, which is the bound working |

`prl_analysis_duration_seconds` measures **end to end including time queued**, so compare it against `prl_worker_pool_queued`: high duration with an empty queue is slow work, high duration with a deep queue is waiting.

Check the pool warnings in the log — the pool cannot log for itself and reports through `onWarn`:

```bash
kubectl logs <pod> | grep -E 'worker-error|worker-exit|task-timeout|protocol-mismatch'
```

`protocol-mismatch` means the worker script and the pool disagree about their message shape. That is a deployment defect — a half-updated image — not capacity.

## Recovery

**Blocked event loop**

| Cause | Action |
| --- | --- |
| Expensive work on the main thread | move it to the pool; roll back the deploy that introduced it → [rollback.md](rollback.md) |
| Large frames to many sockets | reduce concurrent sockets per instance; the measured ceiling is in [`../load-test.md`](../load-test.md) |
| GC pressure | restart to restore service, then treat the memory growth as a ticket with the metric series attached |
| Genuine overload | add instances. Note that a table lives in one process, so this spreads *tables*, never one table |

**Saturated worker pool**

| Cause | Action |
| --- | --- |
| At capacity | reduce `MONTE_CARLO_MAX_SAMPLES`, or add instances. Do not exceed `cores - 1` workers |
| Individual analyses too slow | lower `MONTE_CARLO_MAX_SAMPLES`; the exact-then-Monte-Carlo split is `docs/adr/0005` and the sample ceiling is the knob |
| Threads died | restart the process; then find out why they exited — a worker that crashes repeatedly is a defect |
| Timeout too tight | `COACH_TIMEOUT_MS` is a wall-clock budget. Raising it trades a refused analysis for a slower one; it does not create capacity |

Never disable the queue bound. An unbounded queue turns a CPU limit into a memory limit and a latency limit into neither — every caller waits, then fails, having consumed a slot anyway.

## Verification

```bash
# 1. The loop is quiet again. p99 under a few milliseconds, max not spiking.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_event_loop_delay

# 2. The queue drains: busy varies, queued returns to 0.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_worker_pool_

# 3. Analyses succeed rather than time out or get rejected.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_analysis_total

# 4. Latency recovered across the board, not just on the Coach path.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_http_request_duration_seconds_bucket | head

# 5. Turn clocks and sockets are healthy again — no reconnect wave left behind.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E 'prl_websocket_(connections|opened_total|closed_total)'

# 6. End to end.
pnpm run test:smoke --strict
```

If the incident involved the event loop, also confirm no hands were lost to late turn clocks: `prl_hands_started_total` and `prl_hands_completed_total` should be rising together again.

## Escalation

Escalate when:

- The event loop is blocked and no code path explains it. Something on the main thread is doing work nobody knows about, and that is a correctness risk as much as a latency one.
- Worker threads exit repeatedly. A crashing worker can leave a Coach analysis half-computed, and a wrong analysis is worse than a refused one → [incorrect-coach-result.md](incorrect-coach-result.md).
- Saturation appears at load the deployment previously handled. That is a regression; find the deploy.
- The measured capacity in [`../load-test.md`](../load-test.md) is being exceeded routinely. That is a sizing decision, not an incident, and continuing to treat it as an incident guarantees it recurs.
