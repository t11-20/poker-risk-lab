# Load and capacity

What was measured, in what environment, and — as importantly — what these numbers are not.

**Candidate SHA:** `4a17e3cec3a6418be34ee7b3efd69cbfe84446b2` (clean tree).
**Harness:** `scripts/load-test.mjs`. Journey per virtual user: connect → join room → sit → play → request Coach → disconnect → reconnect → finish the hand → open Hand Review. Server-side figures are scraped from `GET /metrics` on the process under test.
**Captures:** `{SCRATCH}/load-test.log` + `load-test.json` (ramp 1–12 tables), `{SCRATCH}/load-test-saturation.log` + `load-test-saturation.json` (ramp 16–32 tables), `{SCRATCH}/worker-tests-4a17e3c.log` (cold/warm Coach), `{SCRATCH}/metrics-3104.txt`.

`{SCRATCH}` on this run:
`/var/folders/7s/l9fr0tyd4wn9vp8qhg9yv7g80000gn/T/grok-goal-843cf6607006/implementer`

---

## Read this before quoting any number

**A "player" here is a load shape, not a person.** Think time is **0 ms**. Each seat asks Coach mid-hand (paced), reconnects every two hands, and opens Hand Review every two hands. A real learner spends minutes reading a Coach panel. **Do not convert these figures into a population of learners.**

**The environment is part of the measurement:**

| | |
| --- | --- |
| Instances | one API process (`node apps/api/src/server.ts`) on `http://127.0.0.1:3104` |
| `NODE_ENV` | `development` (`LOG_LEVEL=warn`), asserted with `--server-env development` |
| Host | darwin/arm64, 10 logical CPUs, 16 GiB, Node v24.18.0 |
| Generator | **the same machine**, over loopback |
| Transport | plaintext, **no proxy, no TLS** |
| Database | compose Postgres on the same machine |
| Rate limits | raised on this process only (`RATE_LIMIT_MAX=100000`, `RATE_LIMIT_GUEST_MAX=10000`, `RATE_LIMIT_EXPENSIVE_MAX=10000`, `RATE_LIMIT_BAN_AFTER=0`) so the ramp measured the server rather than the limiter. `prl_rate_limit_events_total` was **0** at every level. Production and staging keep the shipped limits; the consecutive smokes did not raise them. |
| Other tenants | competing APIs on :3000/:3001/:3101/:3458 were stopped before the ramp. Load average at start of the saturation hunt was already ~7. |

A production deployment differs on every row.

The first ramp completed without crossing a stop criterion. The plan requires an **observed** saturation point, so a second ramp was run until one fired. Both harness invocations completed and emitted a full report.

---

## The measured result

**One instance saturates at 96 concurrent zero-think virtual users, stopped by error-rate. The highest level that still met every stop criterion is 72 seated players.**

Saturation hunt (`--ramp 16,24,32 --seats 3 --hold 15`, 2026-08-22T18:02:52Z–18:03:42Z):

| Level | Seated players | Hands/min | Act/s | Action p50 / p95 / p99 | Coach p95 | Review p95 | Errors | Error rate |
| --- | ---: | ---: | ---: | --- | --- | --- | ---: | --- |
| 1 | 48 | 11,817 | 2,472 | 2.5 / 7.7 / 18.4 ms | 97.0 ms | 3,860 ms | 228 | 0.53% `service_unavailable` |
| 2 | **72** | **12,862** | **2,696** | **3.4 / 8.4 / 12.7 ms** | — (n=0) | 2,636 ms | 368 | 0.78% `service_unavailable` |
| 3 | 96 | 9,672 | 2,032 | 5.2 / 13.4 / 20.0 ms | — (n=0) | 2,638 ms | 513 | **1.37%** — stop |

Envelope below that (`--ramp 1,2,4,8,12`, 2026-08-22T17:59:18Z–18:02:04Z), all five levels passing:

| Level | Players | Hands/min | Act/s | p50 / p95 / p99 | Event-loop p99 | CPU cores | RSS | Errors |
| --- | ---: | ---: | ---: | --- | --- | ---: | --- | ---: |
| 1 | 3 | 1,637 | 334 | 0.1 / 0.3 / 0.6 ms | 1.5 ms | 0.16 | 376 MiB | 1 |
| 2 | 6 | 12,432 | 1,669 | 0.2 / 0.6 / 1.2 ms | 2.7 ms | 1.03 | 516 MiB | 1 |
| 3 | 12 | 5,982 | 974 | 0.4 / 1.3 / 2.6 ms | 3.8 ms | 0.98 | 511 MiB | 9 |
| 4 | 24 | 6,534 | 1,262 | 0.9 / 3.0 / 5.8 ms | 5.1 ms | 1.59 | 581 MiB | 48 |
| 5 | 36 | 7,770 | 1,603 | 2.3 / 7.3 / 13.9 ms | 18.9 ms | 2.91 | 610 MiB | 142 (all `service_unavailable`) |

Reconnect consistency: **0 failures** on both runs (every reconnect resumed the same seat, hand, hole cards, non-decreasing action sequence and non-shrinking pot).

---

## Saturation point, bottleneck, recommended ceiling

**Saturation:** 96 seated players, stopped by `error-rate` (1.37% of 37,477 operations). Every failed operation at that level was `service_unavailable` — the **bounded worker queue refusing** rather than growing.

Classification signals at the failing level (not themselves stop criteria):

| Signal | Observed | Threshold | Fired |
| --- | --- | --- | --- |
| event-loop p99 | 17.51 ms | 50 ms | no |
| CPU | 4.16 cores | 0.9 cores | yes |
| worker-pool queued | 12 tasks | 1 | yes |
| db-probe p99 | 500 ms | 50 ms | yes |
| rate-limit refusals | 0 | 1 | no |

**Primary bottleneck:** the worker pool (queue depth 12, busy 4) plus this process competing with the generator for CPU. Action latency stayed well inside the 150/250 ms p95/p99 stop criteria even at 96 players. Hand Review p95 was 2.6–3.9 s: that is the expensive path, served off the main thread, which is why the event loop stayed quiet while the queue refused work.

**Recommended operational ceiling, with headroom:** **36 zero-think virtual users on one instance** in this environment (error rate 0.43%, event-loop p99 18.9 ms, action p99 13.9 ms). 72 players still met the harness stop criteria but was already refusing 0.78% of operations and running 4+ CPU cores on a 10-core laptop that was also generating the load. A TLS proxy, a remote database, and non-zero think time all change this number; none of them were in this measurement.

---

## Cold vs warm Coach

The load warmup on 3104 reported **first Coach n=0**: that process had already awaited worker warmup before `listen`, so the throwaway level never paid the cold strength-table cost. The harness footnote that still says "the first Coach analysis runs a Monte Carlo on the main thread" is **stale relative to this SHA** — Coach is on the worker pool.

Measured on this SHA (`{SCRATCH}/worker-tests-4a17e3c.log`, 44/44 pass):

| Observation | Value |
| --- | --- |
| Socket Coach including cold strength table | 3,002 ms |
| Same analysis computed on the main thread (negative control) | blows the event-loop budget (2,969 ms of loop delay) |
| Pre-warm: `/ready` 503 until workers usable, then a top:40 Coach is not the cold path | 3,037 ms for the whole case (warmup + assertion) |
| Event-loop p99 during load warmup (warm process) | 1.1–1.2 ms |
| First Hand Review (warm) | 21 ms |

---

## What this did not measure

- More than one API instance.
- A real network, TLS, or the staging nginx proxy.
- A production-sized database.
- Browser clients.
- Sustained running (holds are 15 s).
- A cold start of the **process** under the ramp (`--skip-warmup` was not used for the saturation hunt; cold Coach is the worker-test figure above).

The default `pnpm run test:load` exits 1 when a stop criterion fires. That is a capacity measurement, not a test to loosen. The saturation hunt exited 1 and wrote a complete JSON report; that is the intended outcome of finding the ceiling.
