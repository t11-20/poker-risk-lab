# Reliability drills

**Candidate SHA:** `68394b3df5dc51f45fa7409a3541c224861dad49` — **16 of 16, `DRILLS_EXIT=0`, wall 142.6 s**, isolated, re-run 2026-08-25 after the room-settlement and turn-timer fixes.

**Previous candidate SHA:** `b292b2ac234cb586f253ad42ec0ef4d949fa332b`
**Command:** `node --env-file-if-exists=.env scripts/reliability-drills.mjs`
**Capture:** `{SCRATCH}/drills.log` (`DRILLS_EXIT=0`, 16 of 16 passed, wall 141.4 s), isolated after a contended FAIL.

`{SCRATCH}`:
`/var/folders/7s/l9fr0tyd4wn9vp8qhg9yv7g80000gn/T/grok-goal-843cf6607006/implementer`

A first run on this SHA (`{SCRATCH}/drills-contended-with-verify.log`) failed `slow-simulation` while `pnpm run verify` was still using the same machine: the second overrun answered 200 instead of 504. That is host contention, not a passing re-roll of a broken assertion. The isolated rerun, with the leftover API/web stopped, passed all 16.

**Re-run 2026-08-24** on the same application tree (`git diff b292b2a 5e3cbbc -- apps packages` was empty **at the time**; written as `HEAD` it now reports 147 files and 23,339 insertions, so do not run the `HEAD` form as a freshness proof — this capture predates 25+ commits including changes to `pots.ts`, `coach.ts` and the table components), isolated: **16 of 16, `DRILLS_EXIT=0`, wall 142.2 s**. One release review recorded these as "not run under the repository's hard destructive-command policy" — that was a restriction on that review's own harness rather than a property of the suite, and this run is the same sixteen drills from the same tree with nothing waived.

---

## Isolated results

| Drill | Result |
| --- | --- |
| `sigterm-idle` | PASS |
| `sigterm-mid-hand` | PASS — close 4503, chips conserved |
| `ws-disconnect-mid-hand` | PASS |
| `silent-tcp-during-drain` | PASS — drain `ECONNREFUSED` |
| `restart-with-active-rooms` | PASS — **12/12** Legend profiles rehydrated |
| `partial-deployment` | PASS |
| `malformed-ws-traffic` | PASS |
| `duplicate-actions` | PASS |
| `out-of-order-actions` | PASS |
| `worker-crash` | PASS — replacement thread serves the next job |
| `slow-simulation` | PASS (isolated) — 504 `computation_timeout`, recovery 200 |
| `postgres-outage` | PASS — `/health` 200, `/ready` 503, recovers |
| `postgres-restart` | PASS |
| `pool-exhaustion` | PASS |
| `failed-migration` | PASS — roll-forward only |
| `dependency-unavailable` | PASS — OIDC 502, guest still works |

`/ready` fails quickly when the database does not answer and recovers after. `/health` stays a liveness probe. Staging stop-api produced nginx **504** on the TLS origin (`rollback.log`).
