# Final production-readiness report

**Frozen application/evidence candidate SHA:** `f9747bda63ca65be6eb15d54b72809a8e0ba46ba`

The final documentation publication below is docs-only; the application tree is unchanged from
this frozen candidate. All executable evidence in this report is bounded to this candidate or to
the explicitly identified earlier artifact source.

**Tree status at final freeze:** clean after the documentation publication commit (`git status
--porcelain` empty).

**Host:** macOS/Darwin arm64, Node 24.18.0, pnpm 11.10.0, Docker server 29.6.1, local PostgreSQL
Compose container. Dates in command output are retained as observed; the host/database clock was
one day behind the session date in some generated logs.

## Verdict

# RELEASE: FAIL

The hardening work is substantial and the executable application tests are strong, but this is not a
production approval. The exact final candidate does not yet have a same-SHA production artifact
manifest, strict container-CVE clearance, delivered alerting, or real screen-reader certification.

## Candidate and artifact identity

The hardening history inspected was:

- `f7a9253` — worker/operations/legal/prewarm hardening;
- `f1c56ee` — startup warmup race fix;
- `0a7b93f` — release test startup/shutdown hardening;
- `68f733b`, `8e56905` — browser focus/diagnostic hardening;
- `fd20e8b`, `4a17e3c` — security-audit test budget hardening;
- `348f75b` — staging proxy certificate refresh fix;
- this final documentation commit.

The production image manifest currently available was built once from clean `4a17e3c`, before the
staging-only fix:

| Service | Immutable local digest | Manifest tag |
| --- | --- | --- |
| API | `sha256:9a8457e8ae427d64b7cd2aa4da65f2a978cc55ad347d1842c6822e8beba72abe` | `prl-api:4a17e3cec3a6` |
| Web | `sha256:34ba79323e2e0be06a7f935351401a3cc6ae8b9b1561e371d1cfa05263dccbb2` | `prl-web:4a17e3cec3a6` |

The manifest says `commit.dirty=false`, but its commit is `4a17e3c`, not the final SHA above. The
staging fix is excluded from the runtime filesystem, and the exact pair was exercised successfully,
but that does not make the manifest same-SHA provenance. A release operator must rebuild once from the
final SHA, record new digests, rescan them, and repeat staging before promotion. No rebuild was done
after the staging fix during this review.

## Worker and performance hardening

Verified by source review, API tests, load metrics, and safe drills:

- Coach and Hand Review Monte Carlo work crosses into worker threads; negative controls show the
  equivalent in-process computation blocks the event loop.
- The shared pool has bounded queue capacity and returns typed `service_unavailable` when full.
- Worker deadlines are enforced; an overrun terminates the worker and the pool replaces it.
- Crash, timeout, close, and recreate paths reject safely and do not retain stale pool references.
- Shutdown terminates workers; the API suite verified idle, in-flight, WebSocket, partial-TCP, and
  worker-active SIGTERM behavior.
- Startup awaits the required warmup before `listen`; readiness remains unavailable until the
  required warmup is usable. Health is liveness-only.
- The pool uses public/known calculation inputs only; no deck, salt, future deck, RNG secret, or
  opponent hole cards cross the worker boundary.

Observed cold/warm samples were approximately 2.97 s versus 4 ms for one top-strength Coach task,
3.32 s for four concurrent cold tasks versus 4.5 ms warm, and 3.05 s for lifecycle prewarm. These
are samples, not percentile claims. Prewarming is retained because it materially removes the cold
request path and is paired with readiness gating.

## Executed verification

The following were run against the frozen application/evidence candidate
`f9747bda63ca65be6eb15d54b72809a8e0ba46ba`, whose application history includes `348f75b` and the
import-safe staging test hardening in `b3d1f13`. The commits after that candidate change
documentation only.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` | PASS, up to date; scripts disabled |
| `pnpm run lint` | PASS, 478 files |
| `pnpm run typecheck` | PASS, 8 workspace projects |
| `pnpm run test:unit` | PASS, web 340 tests plus package suites |
| `pnpm run test:scripts` | PASS, 422/422, 82 suites; a sandboxed invocation cancelled 3 SBOM tests because SQLite could not open the pnpm store, then the elevated rerun passed with the existing store accessible |
| `pnpm --filter @prl/api test` | PASS, 812/812 tests, 201 suites, 0 fail/cancel/skip |
| `pnpm run test:exhaustive` | PASS, 2 tests; all 133,784,560 seven-card hands classified |
| `pnpm run test:simulation` | PASS, 23 tests; 12 AI profiles and distribution checks |
| `pnpm run build` | PASS, production package/API/web builds; Next generated 82 pages |
| `pnpm run fixtures:check` | PASS |
| `pnpm run design:contrast` | PASS, token and rendered layers |
| `pnpm run db:migrate:status` | PASS, 4 applied/matching, 0 pending |
| `pnpm run db:verify` | PASS, 123 columns, 41 indexes, 13 values/constraints/privileges checks |
| `pnpm run db:roles` | PASS |
| `node --test scripts/staging.test.mjs` | PASS; certificate renewal regression covered |
| `pnpm run test:a11y` | PASS, 7 routes, 0 static violations |
| `pnpm run test:keyboard` | PASS, 142 checks; one live-table route was N/A because it had no seat, while the real live journey completed |
| `pnpm run test:ax` | PASS, 46 computed-tree checks |
| `pnpm run test:csp` | PASS, 11 browser enforcement/negative-control checks |
| two strict smoke runs | PASS; immediate consecutive runs passed after bounded rate-limit wait, without weakening production limits |

The exhaustive evaluator, poker-engine invariants/property tests, WebSocket, reconnect/idempotency,
database, hidden-information, migration, shutdown, concurrency, 12-profile rehydration, and
security-audit suites are included in the API/package/script results above.

## Security, SBOM, and image scans

Passed explicit gates:

```text
pnpm run security:policy
pnpm run security:denylist
pnpm run security:shapes
pnpm run security:provenance
pnpm run security:ioc
pnpm run security:pinning
pnpm run security:hygiene
pnpm run deps:quarantine -- --help
pnpm run security:osv          # 0 findings across 162 resolved versions
pnpm run security:sbom         # 170 components, 171 dependency records
pnpm run security:audit        # all repository policy gates pass
pnpm run security:containers   # policy result: 0 blocking, 60 unfixable HIGH+
```

The stricter command `pnpm run security:containers -- --include-unfixed` was also run and failed as
expected with 60 HIGH/CRITICAL findings (30 per image, no available fix, no allowlist entries).
They are real Debian bookworm-slim findings, not ignored findings. The repository’s default policy
does not block unfixable base-image findings, but production approval cannot call the images CVE-free;
the base-image refresh is a release-blocking follow-up.

The security best-practice review found no demonstrated P0/P1 application exploit in the reviewed
worker, poker, authorization, hidden-information, or logging paths. It did retain P2 observations:
the readiness worker check is a warmup latch rather than a live crash indicator, in-flight database
work can remain held to its request bound during an outage, and the image healthcheck is liveness-only.

## Capacity

The realistic load journey reached actual saturation. At 3 seated virtual players it measured 32.06
actions/s, 156.25 hands/min, action p50/p95/p99 0.81/3.05/18.50 ms, Coach p95 102.83 ms, Review p95
1,248.85 ms, event-loop p99 21.93 ms, CPU 0.72 cores, worker queue 0, and 125/125 consistent
reconnects. At 6 players it measured 54.80 actions/s and 256.35 hands/min, but action p99 rose to
66.22 ms, Coach returned 0/48 answers, Review p95 reached 10,695.78 ms, event-loop p99 68.51 ms,
worker queue peaked at 12, and 15/1,193 operations returned `service_unavailable` (1.26%).

The observed saturation point is **6 concurrent seated virtual players** for that one local instance
and workload. A conservative ceiling for the measured environment is **3 concurrent seated virtual
players**. This is not a cluster or production-population claim; see `load-test.md`.

## Readiness and failure behavior

Verified:

- frozen DB: health stayed 200; readiness failed in about 612 ms with a bounded database error;
- DB unpause/restart: readiness recovered 200 in about 25–38 ms;
- API SIGTERM idle, active, worker-active, WebSocket, partial request, and silent TCP cases exited
  cleanly and did not leave workers behind;
- worker crash/timeout/closed-pool cases returned typed errors and recovered;
- malformed WebSocket, duplicate, stale/out-of-order, reconnect, and idempotency cases were safe;
- restart with active rooms rehydrated all 12 profiles without strategy substitution;
- hidden-card/future-deck scans found no leak, and chip/state invariants held;
- a stopped API failed through the staging proxy and the candidate digest restored readiness.

## Backup and restore

An actual non-destructive rehearsal used a new scratch archive directory and a fresh target database:

- encrypted backup: 131.9 MiB, 13 tables, 826,152 rows;
- archive signature, ciphertext, authenticated frame decryption, and `pg_restore --list`: PASS;
- restore into new `prl_restore_rc_20260823020659`: PASS, 36.72 s restore, matching 13-table census;
- restored schema verification: PASS;
- API started against the restored DB: `/ready` 200 with database/workers and `/health` 200.

The destructive `verify --deep` path was not run because it drops its scratch database. No WAL
archiving exists; RPO is the backup schedule interval. The observed restore/RTO is local evidence,
not a production SLA.

## Staging and rollback

The exact existing image digests were deployed to the local production-shaped stack with PostgreSQL,
production cookies/secrets generated outside the image, TLS, nginx WebSocket forwarding, HSTS, CSP,
health/readiness checks, and strict smoke. The first TLS failure exposed and led to the targeted proxy
refresh fix; two post-fix runs passed. Full details are in `staging-verification.md`.

A non-destructive candidate → API stop/failing readiness → previous local API/web digests → candidate
restore rehearsal passed. It is local BuildKit evidence only; the previous pair was a dirty local image,
not a signed previous production release. Full details are in `rollback-verification.md`.

## Observability and alerting

The API exports actionable families for HTTP latency/errors, WebSockets, rooms/hands, event-loop lag,
worker utilization/queue depth, Coach latency, DB pressure/errors, auth failures, authorization
failures, rate limits, restarts, and readiness. Drill and staging conditions produced readiness/error
signals and logs were checked for tokens, secrets, unrevealed cards, future deck state, and RNG
material; none was observed.

There is no Prometheus/Alertmanager/paging destination in the available staging Compose stack. Metric
conditions can be produced, but alert delivery and a real critical-alert notification are
**UNVERIFIED**. This is a release blocker, not a documentation PASS.

## Screen reader

The genuine VoiceOver+Safari/NVDA+Chrome/Firefox procedure is in `accessibility-certification.md`.
It was not executable on this host. AX, axe/static checks, contrast, and keyboard checks do not count
as screen-reader certification. Status: **UNVERIFIED**.

## Independent adversarial challenge

A fresh read-only challenge was performed after the worker/staging changes. It found no demonstrated
P0 such as hidden-card leakage, chip creation/destruction, auth bypass, or silent strategy
substitution. It did identify the unresolved P1/release evidence gaps above and P2 items: readiness
is not crash-aware after warmup, a frozen database can hold an in-flight request to its bound, and
the local image’s unfixed base-image CVEs are not clean.

## Finding classification

| Severity | Open findings |
| --- | --- |
| P0 catastrophic | 0 demonstrated |
| P1 release-blocking | Real screen-reader certification unavailable; final candidate has no same-SHA image manifest; strict image scan reports 60 unfixed HIGH/CRITICAL findings; alert delivery/external production observability unavailable; registry-attested staging/rollback unavailable |
| P2 significant | Readiness is a warmup latch after startup; one in-flight DB request can remain held to its bound during outage; cold Coach sample is ~3 s before warmup; capacity is only measured on loopback |
| P3 polish | None material to this verdict |

## Commands intentionally not run

`pnpm run test:drills` and backup `verify --deep` were withheld because their implementation executes
DROP/destructive cleanup prohibited by the operator’s hard rule. No result is inferred from their
documentation. A safe subset and all non-destructive API/readiness/recovery gates are reported above.

## Required before release approval

1. Run the documented human screen-reader certification and attach spoken evidence.
2. Rebuild production API/web artifacts exactly once from this final SHA, record new digests, scan
   those digests, and rerun same-digest staging.
3. Refresh/replace the base image or obtain security approval for every strict-scan finding; do not
   silently expand the allowlist.
4. Connect metrics to real alert rules and prove a critical notification reaches an operator.
5. Repeat rollback with a signed previous production digest and external secret/configuration path.

RELEASE: FAIL
