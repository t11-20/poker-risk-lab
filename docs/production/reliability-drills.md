# Reliability drills

**Candidate SHA:** `4a17e3cec3a6418be34ee7b3efd69cbfe84446b2`.
**Command:** `node --env-file-if-exists=.env scripts/reliability-drills.mjs`
**Capture:** `{SCRATCH}/drills.log` (`DRILLS_EXIT=0`, 16 of 16 passed, wall 173.5 s).
**Related:** `{SCRATCH}/worker-tests-4a17e3c.log` (pool close/restart, crash, queue bound, timeout, `/ready` warmup), `apps/api/test/shutdown.test.ts` (in the full `pnpm run test` on this SHA).

`{SCRATCH}`:
`/var/folders/7s/l9fr0tyd4wn9vp8qhg9yv7g80000gn/T/grok-goal-843cf6607006/implementer`

These drills broke **one local process** against a development database over loopback. They say named failures are handled. They say nothing about a real deployment, a real network, or how much load any of this survives.

---

## Results on this SHA

| Drill | Result | What was shown |
| --- | --- | --- |
| `sigterm-idle` | PASS | Clean stop in 16 ms, exit 0, replacement `/ready` in 21 ms |
| `sigterm-mid-hand` | PASS | Socket closed 4503; 4 units in pot at signal; chips conserved (400); reconnect 25 ms; replacement ready 63 ms; shutdown 22 ms |
| `ws-disconnect-mid-hand` | PASS | Drop without handshake; reconnect 7 ms; chips 400 |
| `silent-tcp-during-drain` | PASS | Open silent TCP at SIGTERM; new connection during drain `ECONNREFUSED`; stop 40 ms |
| `restart-with-active-rooms` | PASS | **12 / 12** Legend profiles rehydrated with their own identity; 8 opponent actions after restart, 0 forced |
| `partial-deployment` | PASS | API healthy with web down; web `/` 200 in 9 ms with API down, no stack/path/errno |
| `malformed-ws-traffic` | PASS | Oversized / bad JSON / unknown type / wrong version / binary; close codes 4429 / 1009 / 4400; a full hand still plays after |
| `duplicate-actions` | PASS | Second submit did not double-pay (committed 3 → 4, not 5) |
| `out-of-order-actions` | PASS | Stale `expectedSequence` refused |
| `worker-crash` | PASS | Dead thread surfaces a typed error; next job still runs |
| `slow-simulation` | PASS | Over-budget Coach → 504 `computation_timeout`; recovery request 29 ms / 200 |
| `postgres-outage` | PASS | Private frozen Postgres; `/health` 200 (slowest 6 ms); 3/3 `/ready` 503 in ≤6 ms; held probe 604 ms → 503; ready again 6 ms after unpause |
| `postgres-restart` | PASS | Ready again 329 ms; a real query 7 ms later; guest create recovered |
| `pool-exhaustion` | PASS | `/ready` 503,503,503 under saturation; histogram shows queueing; recovered 8 ms |
| `failed-migration` | PASS | Failed migration rolled back (0 ledger rows); checksum drift and orphan ledger abort; `migrate down` refuses (roll-forward only) |
| `dependency-unavailable` | PASS | Bad OIDC: instance stays ready; guest sign-in works; `/auth/oidc/start` 502 in 47 ms (refused) / 5,026 ms (black hole) |

---

## Readiness / liveness

`/ready` fails quickly when a required dependency is down and recovers after. `/health` stays a liveness probe:

- Frozen DB: `/ready` body `{"status":"degraded","checks":{"database":{"ok":false,"detail":"database did not answer within 600 ms"},"workers":{"ok":true}}}` while `/health` stayed 200.
- Staging simulated failure (stop API): `https://localhost:8443/api/v1/ready` returned nginx **504**. Restoring the candidate digest returned `{"status":"ready","checks":{"database":{"ok":true},"workers":{"ok":true}}}`.

On this SHA, `server.ts` **awaits** worker warmup before `listen`. `/ready` includes `workers` when warmup is required. `/health` does not.

---

## Residual observations (not failures)

- `postgres-outage` warned: an authenticated `GET /rooms` did not answer within 4,000 ms of the freeze (`TimeoutError`). A request that hangs for the length of an outage holds a connection. `/ready` itself did not hang.
- After warmup, `/ready` is a **latch** on “warmup completed”, not a live worker-count probe. A later crash is recovered on the next submit or surfaces `service_unavailable`; it does not flip `/ready` to 503. Classified P2 by the independent review; not remediated on this SHA.
- 12-profile rehydration is also covered by `apps/api/test/z3-bot-restart-recovery.test.ts` (PASS in `pnpm run test` on this SHA).
