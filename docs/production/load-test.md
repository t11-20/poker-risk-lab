# Load and capacity

> **Current candidate `68394b3`, on Alpine.** The saturation hunt below was measured on the Debian
> build and remains the recorded measurement for the shape of the bottleneck. The Alpine image was
> re-measured on 2026-08-25 to answer the one question the base change opened — whether the Monte
> Carlo worker pool behaves under sustained load on musl. Driving the **container** (not a host
> process) with all limits raised, `--ramp 8,16,24,32 --seats 3`: highest passing **24 seated
> players** at p95 9.9 ms, saturating at 48 on **CPU and the worker queue** with the event loop
> still quiet — the same bottleneck ordering the Debian build showed. **Zero** rate-limit refusals
> and **zero** reconnect-consistency failures. The absolute numbers are lower than the hunt below
> because that container shared the machine with a full staging stack and reached its database over
> the host gateway; what reproduces is which resource runs out, not how many players fit.


**Candidate SHA (API/web tree):** `b292b2ac234cb586f253ad42ec0ef4d949fa332b`.
`git diff 4a17e3c b292b2a -- apps/api packages apps/web` is empty. The saturation hunt was measured against that API tree (`{SCRATCH}/load-test.log`, `load-test-saturation.log` / `.json`). Harness: `scripts/load-test.mjs`.

`{SCRATCH}`:
`/var/folders/7s/l9fr0tyd4wn9vp8qhg9yv7g80000gn/T/grok-goal-843cf6607006/implementer`

---

## Environment

One API process, `NODE_ENV=development`, darwin/arm64 10 CPUs, generator on the same host, loopback, no TLS. Rate limits raised **on that process only**. Production/staging smokes did not raise limits.

A "player" is think time 0 ms. Do not convert into a learner population.

---

## Saturation

Second ramp `--ramp 16,24,32 --seats 3` until a stop criterion fired:

| Players | Hands/min | Act/s | p95 / p99 | Errors | Result |
| ---: | ---: | ---: | --- | ---: | --- |
| 48 | 11,817 | 2,472 | 7.7 / 18.4 ms | 228 | OK |
| **72** | **12,862** | **2,696** | **8.4 / 12.7 ms** | 368 | **highest passing** |
| 96 | 9,672 | 2,032 | 13.4 / 20.0 ms | 513 | **stop: error-rate 1.37%** |

All errors at the stop were `service_unavailable` (bounded worker queue). Reconnect consistency: 0 failures. Rate-limit events: 0.

**Bottleneck:** worker queue (peak 12) plus CPU on a laptop that also ran the generator. Event-loop p99 stayed under 50 ms.

**Recommended ceiling:** 36 zero-think virtual users on one instance in this environment.

---

## Cold vs warm Coach

Load warmup first Coach n=0: the process had already awaited worker warmup before `listen`. Worker tests on this SHA: cold socket Coach ~3.0 s; after `/ready`, not the cold path; negative control on the main thread blows the event-loop budget (`worker-tests.log`).

---

## Reconciling two reviews that reported different capacities

Two independent release reviews of this project reported capacity figures an order of
magnitude apart. One recorded the saturation hunt above. The other recorded **"capacity
saturated at 6 seated players; conservative ceiling: 3 for the measured local
environment."** Both cannot describe the same system, and the difference is not a
measurement error — it is the difference between a run the harness produced a capacity
figure for and a run in which it refused to.

Three runs were made against the same API tree to establish which is which
(`git diff 4a17e3c HEAD -- apps/api packages apps/web` is still empty, so this is the same
application code as the frozen candidate). Captures are stamped with the API's rate-limit
configuration, because that is the variable:

| Rate limits on the measured process | What the harness did |
| --- | --- |
| Stock (`.env`: `RATE_LIMIT_GUEST_MAX=10`) | **Refused to start.** "only 10 of 24 guest sessions could be created … The API rate-limited guest creation. That is the server behaving correctly, not a defect." Exit 1, no levels run, no numbers. |
| `RATE_LIMIT_GUEST_MAX` raised, everything else stock | Ran, and **stopped at level 1 — 3 seated players** — on `refusal-rate-limited`. Report: "**no level met every threshold, so there is no capacity figure**". |
| All limits raised on that process only | Ran the full ramp and produced a capacity figure. See below. |

The middle row is the shape of the disputed number: a ramp that ends on the first level
where the limiter refuses anything, one or two levels in, with the harness declining to
state a capacity. A figure of "saturated at 6, ceiling 3" is that run's *level numbers*
being read as a measurement the harness explicitly said it had not made. It is a
**configured ceiling** — the value of `RATE_LIMIT_MAX`, `RATE_LIMIT_GUEST_MAX` and
`RATE_LIMIT_EXPENSIVE_MAX` — and not a property of the machine or the code.

`scripts/load-test.mjs` now says so where the number is, rather than three lines below it:
a ramp stopped by `refusal-rate-limited` prints that the limiter ended it, that the
concurrency is a configured ceiling and not a capacity, and which variables to raise
before quoting anything from the run.

---

## Second measurement, on a contended host

Not a replacement for the saturation hunt above — a check that its shape reproduces. Same
API tree, all rate limits raised on the measured process, `--ramp 8,16,24,32 --seats 3`.

**The host was busy**: the staging stack (four containers) was running throughout and the
1-minute load average at start was **16.0 on 10 logical CPUs**. The frozen candidate's hunt
was run on an idle machine. Every number here is therefore lower than that one and is
expected to be; what is being compared is which resource ran out, not how many players fit.

| Players | Hands/min | p95 / p99 | Error rate | Event loop p99 | CPU | Worker queue | Result |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| 24 | 7,576 | 7.1 / 15.4 ms | 0.31% | 24.8 ms | 3.04 cores | 11 | OK |
| **48** | **7,509** | **12.4 / 23.8 ms** | **0.82%** | 31.5 ms | 3.20 cores | 12 | **highest passing** |
| 72 | 4,819 | 26.2 / 50.9 ms | 1.92% | 52.7 ms | 2.90 cores | 12 | **stop: error-rate** |

**Rate-limit refusals: 0 at every level** — the limiter was not what ended this run.
**Saturating resource: the event loop**, with CPU and the worker queue also fired; the
database-pool signal fired too and the report annotates it as confounded by the event loop,
which is what it is.

That is the same bottleneck the frozen candidate's hunt found, at a lower concurrency on a
machine doing more. It reproduces the hunt and it does not reproduce a ceiling of 3.

**Do not average the two numbers, and do not quote this one as the capacity.** The frozen
candidate's figure — highest passing 72, recommended ceiling 36 — was measured on an idle
host and remains the recorded measurement for the release. This one exists to say that the
disagreement between the reviews was about the rate limiter and nothing else.

---

## A defect this reconciliation found in the harness

The `db-pool` saturation signal compared a histogram **bound** against its threshold with
`>=`. The observed value is the bucket bound at which the 99th percentile fell, so `50 ms`
means "99% of probes finished within 50 ms" — the threshold being *met*. Firing on `>=`
therefore blamed the database pool for every probe set whose p99 landed anywhere inside the
25–50 ms bucket, including a three-player level at 0.4 requests per second where the reading
is the pool opening its first connection. The report printed `db probe p99 <= 50.0ms` and
`db-pool FIRED 50.00 ms (threshold 50 ms)` on the same screen.

`histogramBoundAtQuantile` also returned `null` for two different facts: "no observations"
and "the quantile fell in the `+Inf` bucket". The second is the slowest reading the
histogram can produce, and downstream `null` means "this build does not export the metric" —
so a probe slower than the top bucket was indistinguishable from an absent metric and the
signal stayed quiet for it.

Both are fixed: the bound is `Infinity` for the overflow case and `null` only for no data,
the signal fires on `>` and on `Infinity`, and the JSON carries `dbProbeP99AboveTopBound`
because `JSON.stringify(Infinity)` is `null`. Negative controls for both are in
`scripts/load-test.test.mjs`. In the run above, the fix is visible at the 48-player level:
its bound is exactly 50 ms, it is the highest passing level, and it no longer carries a
spurious pool-exhaustion diagnosis.

---

## Sizing a cohort

Everything above is a **saturation** measurement: how hard one process can be driven before
it starts refusing. That is the right question for finding the bottleneck and the wrong
question for "how many students can I enrol", and this section exists because the two were
being read as the same number.

### Why you cannot read a cohort size off the tables

A harness "player" has **think time 0 ms** — it acts the instant it is asked. A learner
reads the board, looks at the Coach, and acts perhaps once every ten or twenty seconds. The
tables therefore do not say "24 people fit". They say "24 zero-think actors fit", which is
a different and much heavier thing per person.

The useful currency is **actions per second**, not player count. Converting the measured
runs, using the ~12.5 actions per hand that the idle-host run's two columns imply
(2,472 act/s at 11,817 hands/min) — a derived figure, not a measured one, and stable only
because the seat count was the same:

| Run | Highest passing | Hands/min | Actions/s |
| --- | ---: | ---: | ---: |
| Idle host, one process | 72 | 12,862 | 2,696 (measured) |
| Container, contended host | 48 | 7,509 | ~1,565 (derived) |

A learner acting once every twelve seconds contributes about **0.08 actions/s**. Dividing
one by the other gives a number in the tens of thousands, and that number is **wrong** —
which is the point of stating it. Action throughput is not what runs out first for
human-paced players.

### What actually runs out first for a cohort

Two costs are paid per **room**, continuously, and do not fall when players slow down:

- **State frames.** Under ADR 0009 every change sends a whole redacted frame to every
  socket in the room. Think time delays the change; it does not make the frame smaller or
  the fan-out narrower.
- **Turn timers.** One per seat with a decision pending, ticking whether or not anybody is
  thinking.

And one cost is paid per **request**, and is by far the most expensive thing a learner can
ask for: a **Coach** call, which is bounded Monte Carlo on the worker pool (ADR 0005). The
worker queue is the resource that fired at saturation in both runs. A class told to "press
the Coach button on every street" generates a load profile with almost nothing in common
with the ramps above.

So size by **concurrent seated players and their Coach rate**, not by hands per minute.

### The one honest procedure

The zero-think ramp is a **conservative proxy at equal room count**: 24 zero-think players
at `--seats 3` is 8 rooms, and 8 rooms of real learners cost strictly less. So a ramp that
passes at N players over R rooms is evidence that R rooms of learners are comfortable — and
evidence about nothing else.

Measure on the machine you will actually run on, with the limits production will actually
have:

```bash
# Ramp to the room count your cohort implies (cohort ÷ seats per room), not to a player
# count you hope to serve. Drive the container, not a host process.
node scripts/load-test.mjs --ramp 8,16,24,32 --seats 3
```

Then read the **stop criterion**, not the top row. A run that ends on `refusal-rate-limited`
has measured your rate-limit configuration and not your machine — the harness now says so at
the number rather than three lines below it, and the reconciliation above is what that
warning was written from.

Numbers measured anywhere else, including everything in this file, are evidence about the
**shape** of the bottleneck — CPU and the Monte Carlo worker queue, with the event loop
close behind — and are not a capacity for your deployment.

### The ceiling that no measurement moves

One API process serves every room, and that is a correctness constraint rather than a
sizing choice: see [ADR 0013](../adr/0013-room-affinity-and-horizontal-scale.md). Vertical
scale is available and buys exactly the resources that run out here. Horizontal scale is a
protocol change and is not in this release, so no configuration you can write today serves
hundreds of *concurrent seated* players.
