# Final readiness report

**Candidate SHA:** `4a17e3cec3a6418be34ee7b3efd69cbfe84446b2`
**Tree at freeze:** clean (`git status --porcelain` empty).
**Recorded:** `{SCRATCH}/candidate-sha.txt`
**Date:** 2026-08-22
**Host:** Darwin 25.5.0 arm64, macOS 26.5.2 (25F84), Node v24.18.0, pnpm 11.10.0

`{SCRATCH}`:
`/var/folders/7s/l9fr0tyd4wn9vp8qhg9yv7g80000gn/T/grok-goal-843cf6607006/implementer`

This SHA’s only delta from `fd20e8bfa2d476ff8e71953080d4812732ca79f2` (and from `8e569052154c260c47c7fe58019152f194d361fc`) is `apps/api/test/security-audit-trail.test.ts`: the suite timeout is now 20 s so a 15 s fire-and-forget audit poll is not killed by `node --test`’s 5 s default. **Production code, Dockerfiles, and web bundle are unchanged from `8e56905`.** Images were built from `4a17e3c`.

Prior markdown PASS claims and earlier SHAs are not evidence. Numbers below cite `{SCRATCH}` captures from this freeze.

---

## Verdict

**PRODUCTION HARDENING COMPLETE — EXTERNAL ACCESSIBILITY CERTIFICATION REQUIRED**

Screen-reader certification is **UNVERIFIED** on this host (Apple Event `-1743` / TCC). Every other engineering gate that this environment can run was executed against this candidate and did not produce an unresolved P0 or P1. That is not `RELEASE CANDIDATE: PASS` and not `PRODUCTION READY: PASS` — both require a real spoken walk.

---

## Images

| Service | Digest (local BuildKit store, not registry-attested) |
| --- | --- |
| api | `sha256:9a8457e8ae427d64b7cd2aa4da65f2a978cc55ad347d1842c6822e8beba72abe` |
| web | `sha256:34ba79323e2e0be06a7f935351401a3cc6ae8b9b1561e371d1cfa05263dccbb2` |

`{SCRATCH}/digests.txt`. `commit.dirty=false`.

---

## Worker pool (Coach / Hand Review)

Monte Carlo does not run on the Node main event loop. Shared pool recovers after close. Queue is bounded (`service_unavailable` rather than unbounded growth). Deadlines kill the overrunning thread. `close` leaves worker count 0. Crash surfaces a typed error.

On this SHA, `server.ts` **awaits** `beginSharedPoolWarmup` before `listen`. `/ready` is 503 until required workers are usable when warmup was requested. `/health` is liveness only.

`{SCRATCH}/worker-tests-4a17e3c.log`: 44 tests, 0 fail.

| Measurement | Value |
| --- | --- |
| Socket Coach with cold strength table | 3,002 ms |
| Same work on the main thread (negative control) | blows the event-loop budget |
| Pre-warm then first top:40 Coach | not the ~3 s cold path |
| Load-test event-loop p99 after warmup | 1.1–1.2 ms |

---

## Gates (§3 / §6)

Install path: `pnpm install --frozen-lockfile --ignore-scripts` — already up to date, `INSTALL_EXIT=0` (`{SCRATCH}/frozen-install.log`). Lifecycle scripts disabled in `pnpm-workspace.yaml`.

`pnpm run verify` on the production-identical tree (`8e56905`, `{SCRATCH}/verify.log`): security:audit, hygiene, lint, build, typecheck, design:contrast, test:a11y, test:ax (46/0), test:csp (11/0), test:exhaustive, test:simulation, db:verify all PASS. **`test` FAIL** — `security-audit-trail.test.ts` killed at 5,026 ms by the runner default while waiting up to 15 s for a fire-and-forget row.

Root cause: `node --test` default timeout 5 s < `AUDIT_DEADLINE_MS` 15 s. Fix: suite `timeout` = 20 s. Assertion unchanged. `pnpm run test` on the fixed SHA: **812 API + unit/script suites, fail 0** (`{SCRATCH}/test-after-timeout-fix.log`, `TEST_EXIT=0`).

| Gate | Result | Capture |
| --- | --- | --- |
| Frozen install | PASS | `frozen-install.log` |
| `pnpm run test` | PASS (after timeout fix) | `test-after-timeout-fix.log` |
| Worker tests | 44/0 | `worker-tests-4a17e3c.log` |
| Keyboard | 130 passed, 1 warning (live socket on `next start`) | `keyboard.log` |
| Two consecutive strict smokes | both 62/62, `SMOKE1_EXIT=0` `SMOKE2_EXIT=0`, isolation via `RATE_LIMIT_RESET_TOKEN` (refused in production) | `smoke-consecutive.log` |
| Drills | 16/16 | `drills.log` |
| Exhaustive / simulation | PASS in `verify.log` | `verify.log` |
| CSP negative control | 11/0 | `csp.log` / `verify.log` |
| Supply-chain (IOC, SBOM, OSV, policy, pinning) | PASS in `security:audit` | `verify.log` |
| Container CVE | 0 blocking, 60 unfixable HIGH | `containers.log` |
| Production builds | `release:artifacts` PASS | `containers-build.log` |
| Backup create / verify --deep / restore | all PASS | `backup-restore.log` |
| API on restored DB | `/ready` ready; guest 201; schema verify PASS | `backup-restore-app.log` |
| Staging same-digest + TLS smoke | PASS, 61 checks, `promote` promotable | `staging.log`, `staging-verify.log` |
| Rollback rehearsal | candidate → 504 → previous digest → candidate | `rollback.log` |
| Screen-reader | **UNVERIFIED** (`-1743`) | `screen-reader-blocked.log` |
| Alert **delivery** | **UNVERIFIED** (no Alertmanager in staging compose). Conditions observed. | `alert-fire.log` |

Browser E2E runner: this repo uses Chrome CDP harnesses (`test:ax`, `test:keyboard`, `test:csp`), not Playwright. Those ran.

---

## Capacity

See [`load-test.md`](load-test.md).

Saturation **observed** at **96** zero-think seated players (error-rate 1.37%, all `service_unavailable` from the worker queue). Highest passing level: **72** players, 12,862 hands/min, 2,696 act/s, action p99 12.7 ms. Recommended ceiling with headroom in this environment: **36** virtual users. Rate-limit events: 0 (limits raised on the load process only). Reconnect consistency: 0 failures.

---

## Backup / restore

| Step | Result |
| --- | --- |
| create | 69.7 MiB encrypted, 16.93 s, `CREATE_EXIT=0` |
| verify --deep | signature, checksums, decrypt, `pg_restore` TOC, scratch restore, `VERIFY_EXIT=0` |
| restore `--target prl_restore_rc --drop-existing` | 19.86 s decrypt+restore, 432,258 rows, `RESTORE_EXIT=0` |
| `verify-schema` against restored DB | PASS |
| API on restored DB `:3103` | `/ready` `{database,workers}` ready; `POST /auth/guest` 201 |

**RPO:** the backup schedule interval. There is no WAL archiving.
**RTO (this machine, this archive):** restore ~20 s + API warmup ~3 s before `/ready`. Not a contractual number.

---

## Logs / secrets

API logs from smokes, drills and the load instance were grepped for session tokens, hole-card payloads, deck/cursor/salt and RNG secrets (`{SCRATCH}/log-secret-scan.log`). No hole-card or deck-secret payloads were found. Staging smoke asserted: no socket frame carried a deck, cursor or salt; no live frame carried another seat’s hole cards.

`RATE_LIMIT_RESET_TOKEN` is logged as a configuration warning when set; it is **refused at boot in production**.

---

## Independent review

Read-only adversarial review of `4a17e3c` by an agent that did not implement the fixes (`{SCRATCH}/challenge.md`).

| Severity | Count | Notes |
| --- | --- | --- |
| P0 | **0** | No hidden-card leak, chip-conservation break, auth bypass, or silent strategy substitution proven |
| P1 | **0** | |
| P2 | several | `/ready` workers check is a warmup latch, not crash-aware; audit *absence* uses a 250 ms sleep; keyboard live-table warns and still exits 0; `next start` rewrite is frozen at build time; image HEALTHCHECK is `/health` only; warmup comments still describe fire-and-forget |
| P3 | polish | `style-src-attr 'unsafe-inline'`; `skipOnError` on the in-memory limiter |

No P0/P1 remediated because none were found. Guardrails: no real-money path, public matchmaking disabled at DB CHECK (`visibility = 'invite_only'`), server-authoritative actions, bot rehydrate refuses rather than substituting.

---

## Residual risks

1. **Screen-reader unspoken.** Procedure: [`accessibility-certification.md`](accessibility-certification.md). Must be executed on a machine with VoiceOver+Safari and/or NVDA+Chrome/Firefox and a person listening.
2. **Alert delivery.** Metric families exist; `ApiDown`/`ApiNotReady` conditions were produced; nothing in `docker-compose.staging.yml` pages a human.
3. **Keyboard live table** on `next start` without a proxy: 25 s socket warning. Production topology is the staging proxy; staging smoke completed a hand over `wss://`.
4. **60 unfixable HIGH CVEs** in Debian bookworm-slim (trivy). Changing base image is the remediation.
5. **Digests are local.** Cross-machine promotion needs a registry.
6. **`/ready` after warmup** does not flip on later worker death (P2).
7. **postgres-outage:** in-flight `GET /rooms` can hang for the freeze; `/ready` does not.

---

## What was not done, and must not be read as done

- A spoken VoiceOver or NVDA walk of Learn → Guided Practice → Table/Coach → Lab → Legends → Hand Review.
- A paging Alertmanager notification.
- A registry push or cross-machine rollback.
- Cluster capacity, multi-day soak, or converting zero-think VUs into learners.
- Weakening rate limits, CSP, or tests to go green. Load-test limits were raised on a **dedicated** process, documented, and not used for smokes or staging.

PRODUCTION HARDENING COMPLETE — EXTERNAL ACCESSIBILITY CERTIFICATION REQUIRED
