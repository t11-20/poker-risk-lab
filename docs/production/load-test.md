# Load and capacity

The realistic journey in `scripts/load-test.mjs` was: connect → guest bootstrap/authenticate → join
room → sit → play → request Coach → disconnect → reconnect → complete a hand → open Hand Review.

This is a measured single-instance result, not a population or cluster claim.

## Environment

| Item | Value |
| --- | --- |
| API | one Node instance at `http://127.0.0.1:3001` |
| Node/platform | Node 24.18.0, Darwin arm64, 10 logical CPUs, 16 GiB |
| Database | local PostgreSQL Compose container |
| Transport | plaintext loopback; no proxy/TLS hop |
| API environment | development, asserted by the harness |
| Load setup | 3 seats/table, 15 s hold, 20 s drain, 25 ms think time, reconnect and review every hand |
| Ramp | `1,2,4,8,16`, stopped at first failing level |
| Guest provisioning | `RATE_LIMIT_GUEST_MAX=64` on this dedicated load process only |
| Metrics | authenticated local `/metrics`; token omitted from this report |

The guest-limit override was only to provision the six-user load shape. Production and staging rate
limits were not changed.

## Cold/warm Coach observations

Workers were prewarmed before listening. Observed samples, not percentiles:

| Work | Cold | Warm |
| --- | ---: | ---: |
| One top-strength Coach task | ~2.97 s | ~4 ms |
| Four concurrent first tasks | ~3.32 s | ~4.5 ms |
| Lifecycle prewarm | ~3.05 s before serving |

Readiness remains unavailable until required warmup completes; health is liveness-only.

## Results

The capture was `/private/tmp/prl-load-8e.json`. Level 2 crossed the stop criteria, so the ramp did
not invent higher levels after saturation.

| Seated players | Actions/s | Hands/min | Action p50 / p95 / p99 | Coach | Review p95 | Errors | Reconnect |
| ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |
| 3 | 32.06 | 156.25 | 0.81 / 3.05 / 18.50 ms | p95 102.83 ms (14 answered) | 1,248.85 ms (12) | 0 | 125/125 |
| 6 | 54.80 | 256.35 | 1.50 / 17.52 / 66.22 ms | 0/48 answered; typed unavailable | 10,695.78 ms (19) | 15/1,193 = 1.26% | 206/206 |

At 3 players: CPU 0.72 cores, RSS 261 MiB, event-loop p99 21.93 ms, worker busy peak 2, queue
peak 0, DB probe p99 bound 5 ms. At 6: CPU 1.79 cores, RSS 304 MiB, event-loop p99 68.51 ms,
worker busy peak 4, queue peak 12, and the DB probe reached its 50 ms bound. The DB signal is
confounded by event-loop delay; the primary bottleneck is the API/worker queue boundary.

No rate-limit events, reconnect-consistency failures, chip-conservation failures, or hidden-card
leaks occurred.

## Capacity conclusion

Saturation was observed at **6 concurrent seated virtual players**: error rate exceeded 1%, event-loop
p99 exceeded 50 ms, CPU exceeded the signal, and worker queue depth reached 12. The highest passing
level was 3 players. A conservative ceiling for this exact local workload is **3 concurrent seated
virtual players** with headroom. This is not a production scalability claim; repeat through the
production proxy/TLS/network and with representative user think time before sizing a deployment.
