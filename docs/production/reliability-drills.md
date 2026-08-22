# Reliability drills

## Evidence boundary

`pnpm run test:drills` was **not run**. Its harness creates/drops scratch databases and uses
destructive cleanup, which the operator’s hard rule forbids. No result from that command is inferred
from documentation.

A read-only inventory and an independent safe runner at `/private/tmp/prl-safe-drills.mjs` exercised
the non-destructive process/protocol cases against the existing local database: **11/11 passed**.

## Safe results

| Drill | Result | Evidence |
| --- | --- | --- |
| SIGTERM idle | PASS | exit 0; shutdown ~15 ms; replacement ready ~23 ms |
| SIGTERM mid-hand | PASS | 4 units in pot at signal; 400 conserved; hand settled; replacement ready |
| WebSocket disconnect mid-hand | PASS | reconnect ~4 ms; chips 400; settled |
| Silent TCP during drain | PASS | new connections refused during drain; shutdown ~41 ms |
| Active-room restart | PASS | 12/12 Legend profiles restored; 8 opponent actions after restart; no forced substitutions |
| Partial deployment | PASS | API healthy with web down and web served without API; no stack/errno page |
| Malformed WebSocket traffic | PASS | oversized/invalid/binary/version errors bounded; later hand completed |
| Duplicate actions | PASS | deduplicated and paid once |
| Out-of-order actions | PASS | stale sequence rejected; pot unchanged; hand continued |
| Slow simulation | PASS | typed 504 `computation_timeout`; replacement worker recovered |
| Dependency unavailable | PASS | refused IdP 502; blackhole bounded; health/readiness and guest sign-in remained |

## Database/readiness evidence

The exact API suite passed 812/812 and covers worker crash/timeout/close/recreate, frozen DB deadlines,
SIGTERM with HTTP/WebSocket/partial TCP work, malformed traffic, reconnect/idempotency, hidden
information, and all 12 profile rehydration cases.

Manual checks showed:

- PostgreSQL pause: health 200; readiness 503 in ~612 ms with bounded database detail and workers ok.
- Unpause/restart: readiness recovered 200 in ~25–38 ms.
- Post-restart census: 1,164 users, 302 rooms, 34,438 hands; no state corruption observed.
- Staging API stop: TLS readiness failed through the proxy; candidate recovery returned ready with
  database and workers.

No test or drill exposed a future deck, unrevealed card, token, secret, RNG secret, or silent strategy
substitution. A P2 remains: `/ready` is a warmup latch and does not become 503 solely because a later
worker crashes; submission paths still fail typed and recover.
