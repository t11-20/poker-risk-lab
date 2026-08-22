# Load and capacity

What was measured, in what environment, and — as importantly — what these numbers are not.

Harness: `scripts/load-test.mjs` (`pnpm run test:load`). It drives the real user journey per virtual user: connect → join room → sit → play hands → request Coach analysis → disconnect → reconnect → complete the hand → open Hand Review. It scrapes `GET /metrics` before, during and after every concurrency level, so the server-side figures below are the server's own, not the generator's guesses.

---

## Read this before quoting any number

**A "player" here is a load shape, not a person.** It has **zero think time**, asks the Coach mid-hand, reconnects every two hands and opens Hand Review every two hands. A real learner spends minutes reading a Coach panel — the turn clock is 240 seconds precisely because the panel takes about four minutes to read. So one virtual player is worth many readers, by an unmeasured factor, and **these figures must not be converted into a population of learners**. Doing that is how a capacity number becomes a wrong promise.

**The environment is part of the measurement.** Detach the numbers from it and they mean nothing:

| | |
| --- | --- |
| Instances | one API process |
| `NODE_ENV` | `development` (`LOG_LEVEL=warn`) |
| Host | darwin/arm64, 10 logical CPUs, a laptop |
| Generator | **the same machine**, over loopback |
| Transport | plaintext, **no proxy, no TLS** |
| Database | compose Postgres, same machine |
| Rate limits | raised deliberately (`RATE_LIMIT_MAX=100000`, `RATE_LIMIT_GUEST_MAX=10000`, `RATE_LIMIT_EXPENSIVE_MAX=10000`, `RATE_LIMIT_BAN_AFTER=0`) so the run measured the server rather than the limiter. `prl_rate_limit_events_total` was **0** at every level reported, so nothing was refused |
| Other tenants | **yes** — other development servers were running on the same machine throughout, and are an uncontrolled variable |

A production deployment differs on every row: TLS and a proxy add latency, a separate database host adds network, and a generator that is not competing for the same CPUs changes the shape entirely.

---

## The measured result

**One instance saturates between 12 and 18 concurrent zero-think virtual users, and it is event-loop bound.**

The range is not imprecision, it is the finding. Two runs at identical settings gave 12 players (p95 541.5 ms, p99 1433.4 ms) and 18 players (p99 267.4 ms, with 12 players passing at p99 76.1 ms). The variance is driven by **when Hand Review requests happen to land**, so any single number from this harness needs the range rather than the point.

At a level comfortably inside the envelope — 6 players, all criteria met:

| Measure | Value |
| --- | --- |
| Hands per minute | 5,192 |
| Actions per second | 697 |
| Action latency p50 / p95 / p99 | 0.1 ms / 0.3 ms / 0.6 ms |
| Worker pool busy / queued | 0 / 0 |
| Rate-limit events | 0 |

Sub-millisecond action latency is what a loopback socket to an in-memory table costs, and it is the honest number for that path — it is also why the bottleneck is elsewhere.

---

## The bottleneck, isolated by controlled comparison

Two paths ran heavy synchronous work on the **main thread**, which in this process means blocking every socket, every timer and every turn clock at once.

### Hand Review — the dominant cause

`GET /hands/:handId` replays and prices a hand. Measured at 6 players with 500 ms think time:

| | With review | With `--no-review` |
| --- | --- | --- |
| Action p99 | 1,656 ms | **15.3 ms** |
| Event-loop p99 | 943 ms | **61 ms** |
| Review p95 | 2,876 ms | — |
| Ramp cleared | (saturated) | **24 players at p99 77.8 ms** |

Removing review from the mix moved the ceiling from 12–18 players to 24 with no criterion crossed. At higher levels review p95 reached 5.8 s and then 10.2 s, against a `REQUEST_TIMEOUT_MS` of 20,000 — so it was approaching the point where a review would simply be cut off.

The worker pool sat at **0 busy, 0 queued** throughout. All that capacity was idle while the main thread was the constraint.

### The WebSocket Coach path — a second, smaller cause

`requestCoach` ran a synchronous 2,000-sample Monte Carlo on the main thread. Measured: **1,565 ms** for the first analysis on a fresh process (cold), 67–100 ms warm, and a coach p95 of **6,170 ms** under 24 near-simultaneous requests. The HTTP Coach path already went through the pool; the socket path did not.

Both are now routed through the existing worker pool. See the final readiness report for the after-figures and whether the ceiling moved.

---

## What the metrics said, and one trap in reading them

Two honest caveats about the instrumentation itself, both found by using it rather than by reading it:

1. **`prl_event_loop_delay_*` is written only when the native monitor's window has samples, and every scrape resets that window.** So a scrape taken moments after another renders the *previous* window's values unchanged. Two runs were initially misread because of this. The harness now spaces its scrapes; anyone reading `/metrics` by hand during an incident should know it too.

2. **`prl_db_probe_duration_seconds` is timed inside the `/ready` handler**, so it includes time the process could not reach the event loop at all. Under event-loop blocking it reported a five-second `select 1` against a completely idle database. The metric's purpose is to isolate *pool queueing*, and under this specific failure it measures the loop instead. The harness prints an explicit caveat whenever the db-pool and event-loop signals fire together.

---

## Errors observed

Two, in roughly 45,000 operations at 6 players, neither attributable:

- one `transport:close-4429` — the server closed a socket with `WS_CLOSE.rateLimited`;
- one `illegal_action`.

Both occurred during a level with **4,955 reconnects in 35 seconds**, which is far more socket churn than any real client produces. That is plausibly the harness brushing a real limit rather than a defect, and it is recorded as unexplained rather than dismissed.

---

## What was NOT measured

- **Anything at all under TLS, behind a proxy, or across a network.** Every figure is loopback and plaintext.
- **Multiple instances.** A table lives in one process, so horizontal scaling spreads tables and this measurement says nothing about it.
- **A production `NODE_ENV`.** The runs were `development`. Given that a P0 was found where the production guard changed behaviour (see the readiness report), that gap is worth naming rather than glossing.
- **Sustained load.** These are ramps of minutes, not soak tests. Nothing here says anything about memory growth over days.
- **A realistic think-time population.** The zero-think shape is deliberately hostile and deliberately unlike a learner.
- **Beyond 24 sockets by default.** The default ramp reaches 24; 144 sockets (4/8/16/24 tables × 6 seats) ran with no refusals, so the ceiling there is the machine rather than the harness.

## The default run currently fails, on purpose

`pnpm run test:load` with shipped defaults exits **1** against a healthy local API, because the server genuinely exceeded the 150 ms p95 / 250 ms p99 stop criteria at 12 concurrent zero-think users. That is a real result, not a harness defect. It is left failing rather than loosened, because a stop criterion moved to fit the measurement is not a criterion.

## Reproducing it

```bash
pnpm run test:load --help          # the ramp, the criteria, and every flag
pnpm run test:load --json          # machine-readable, for a before/after diff
pnpm run test:load --no-review     # the controlled comparison that isolated the cause
```

Quote the environment table above with any number taken from it. A capacity figure without its environment is a guess with a decimal point.
