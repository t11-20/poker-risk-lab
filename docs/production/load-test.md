# Load and capacity

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
