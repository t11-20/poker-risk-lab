# Production-readiness report — Poker Risk Lab

**Auditor:** independent of the agents that built this commit. Prior audit markdown is not evidence.

**SHA reviewed:** `c42486a0b61f1bf034941a6efa68149dd26a6583`

**Working tree at recertification start:** clean (`git status --porcelain` empty). `git rev-parse HEAD` equals the SHA above.

**Date:** 2026-08-20

**Environment:** Node 24.18.0 · pnpm 11.10.0 · Docker 29.6.1 · Chrome (keyboard audit) · macOS. Local PostgreSQL 16 via `docker compose` (service `postgres`, healthy). Production API entry: `node --env-file=.env apps/api/dist/server.js` on `:3001`. Production web: `NODE_ENV=production pnpm start` (`next start`) on `:3000`.

**Evidence directory (this run, not in git):** implementer scratch logs named in each section.

---

## Verdict

**`RELEASE: FAIL`**

A mandatory release requirement remains **UNVERIFIED**: a real screen-reader walk of Learn → Guided Practice → Poker Table/Coach → Scenario Lab → AI Legends → Hand Review was not completed. VoiceOver.app is present. VoiceOver could not be enabled or queried for spoken output on this host (Apple Event authorisation `-1743`, `enabled` timeout, Cmd+F5 timeout). NVDA and Orca are not available. ARIA inspection, axe (`test:a11y`), and the keyboard audit are **not** this check.

Every other Phase 1 gate that could be executed on this SHA **passed** with captured output. That is not enough for `RELEASE CANDIDATE: PASS`. `PRODUCTION READY: PASS` is therefore also unavailable.

No application code was changed in this recertification. The Expert-Coach P1 recorded against `56a5128` is closed on this SHA (tests + live `coachAvailable: false`). Public matchmaking remains `invite_only`.

---

## Release-gate results

All of the following were run on **this SHA**, against a tree that matched it.

### `pnpm run verify` — PASS (exit 0)

Log: `{SCRATCH}/verify.log`. Final line: `=== verify: every gate passed ===`.

| Gate | Result |
| --- | --- |
| `security:audit` (policy, hygiene, deny-list, dep shapes, IOC, CI/container pinning, integrity+age, OSV, SBOM) | PASS |
| `security:hygiene` | PASS |
| `lint` | PASS |
| `build` | PASS |
| `typecheck` | PASS |
| `design:contrast` | PASS |
| `test` (unit + integration + script tests, including hidden-info, WS, concurrency, CSRF/CORS, shutdown, bot restart recovery, Expert Coach refusal) | PASS |
| `test:a11y` (static axe of server-rendered HTML; **not** a screen reader) | PASS — 7 routes, 0 violations of checked rules |
| `test:exhaustive` | PASS — 133,784,560 seven-card hands, published frequencies |
| `test:simulation` | PASS — 12 profiles, 23 tests |
| `db:verify` | PASS — 123 columns, 41 indexes, `bot_profile` permits exactly the 13 runtime values, `prl_app` privileges, ownership |

### Strict smoke × 2 — PASS (isolated)

Production API + production web. `PRL_API_ORIGIN=http://127.0.0.1:3001` `PRL_WEB_ORIGIN=http://localhost:3000`.

| Run | Result | Log |
| --- | --- | --- |
| smoke-1 | **60/60**, exit 0 | `{SCRATCH}/smoke-1.log` |
| smoke-2 immediately after | FAIL — leftover `POST /auth/guest` 429 from smoke-1 §12 (address-keyed 10/60s limiter) | superseded |
| smoke-2 after 70s window | **60/60**, exit 0 | `{SCRATCH}/smoke-2.log` |

Primary checks present on **both** passing runs: hidden-info WebSocket scan (no deck/cursor/salt), CSP on the web origin with per-response nonce and no `script-src` `'unsafe-inline'`/`'unsafe-eval'`, guest/session bootstrap, guest rate-limit 429.

The immediate second run is the limiter doing its job, not an app defect. Two isolated `--strict` runs against this stack both exited 0.

### Keyboard accessibility — PASS

`node scripts/keyboard-audit.mjs` against the production web. Log: `{SCRATCH}/keyboard.log`. JSON: `{SCRATCH}/keyboard-audit.json`.

**137/137 passed, 2 warnings.** Warnings are idle/fixture states (“every action control is disabled in this state” / “no action controls are on screen”), not failures. Real Chrome `Input.dispatchKeyEvent`. Includes Learn, guided practice, Scenario Lab, Legends, hand review, table+Coach fixtures, skip link, 390×844 menu trap, and a live private table: open → sit → deal → slider arrows → Fold with Enter, focus survived.

### Production container builds + live CSP — PASS

`docker compose build api web` exit 0.

| Image | Id |
| --- | --- |
| `poker-risk-lab-api:latest` | `sha256:5e20599385e6e9f7a2a365c8d5d9a3f738ddba50211fd9e1a31e3a2dd28aea17` |
| `poker-risk-lab-web:latest` | `sha256:9b75e0e6d9592f1c803bb3c0c99ef890a193d5e69f77f767dd8e73abe065a8a9` |

Web image run read-only with tmpfs, published at `127.0.0.1:3100`. Log: `{SCRATCH}/csp-container.log`.

From the **running image**, `GET /learn`:

- `Content-Security-Policy` present
- `script-src` includes per-response `'nonce-…'`, theme `'sha256-pFr/J6mAOwOBw+OUbWRw3SFuJuxHv7yTRXbAhz9wOxo='`, `'strict-dynamic'`
- `script-src` does **not** contain `'unsafe-inline'` or `'unsafe-eval'`
- 15 `<script>` tags, 0 without nonce; GET header nonce is in that GET’s HTML
- Two consecutive GETs minted **different** nonces
- Companion: `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: same-origin`, `cross-origin-opener-policy: same-origin`

Config-file presence was not used as proof. Residual: `style-src-attr 'unsafe-inline'` is present and confined to that directive.

### 12-profile SIGTERM rehydrate — PASS

Log: `{SCRATCH}/legend-rehydrate.log`. Unknown-plant continuation in the same file plus `{SCRATCH}/api-unknown-rehydrate.log`.

Created one Legends match per strategy profile (rotating educational / realistic / expert), `kill -TERM` API PID 10989, started a new process (PID 11599), `GET /api/v1/rooms/:id` for each.

| Profile | Difficulty | After restart `members[].botProfile` |
| --- | --- | --- |
| vocal-aggressor | educational | vocal-aggressor |
| adaptive-exploiter | realistic | adaptive-exploiter |
| patient-technician | expert | patient-technician |
| reading-pressure-specialist | educational | reading-pressure-specialist |
| old-school-pressure | realistic | old-school-pressure |
| mixed-game-generalist | expert | mixed-game-generalist |
| volume-grinder | educational | volume-grinder |
| disciplined-specialist | realistic | disciplined-specialist |
| foundational-reader | expert | foundational-reader |
| range-narrator | educational | range-narrator |
| fundamentals-coach | realistic | fundamentals-coach |
| calling-station | expert | calling-station |

- Invalid id `not-a-real-legend` → `400 invalid_request`
- None wrote `unknown`
- `visibility` remained `invite_only`
- Expert matches advertised `coachAvailable: false`
- Planted `bot_profile='unknown'` on a new room, SIGTERM, new process: `GET` returned `botProfile: "unknown"` (no substitution). API log: `a bot seat could not be restored and will not act` with reason `the row predates migration 0003 and its strategy profile was destroyed at write time`

### SBOM — PASS

Produced by `security:audit` / `pnpm run security:sbom` on this SHA. Copied to `{SCRATCH}/sbom.cdx.json`.

CycloneDX 1.6, 170 components, 171 dependency records, serial `urn:uuid:9e1ff9ca-f049-46d2-8399-6c83f7eb7204`. Also `docs/sbom/poker-risk-lab.cdx.json`. OSV: 0 findings.

### Expert Coach (prior P1) — PASS on this SHA

Closed in `c42486a` (relative to `56a5128`):

- Server: `WsRouter.onCoach` throws `coach_not_available` when `room.bots.coachDuringHand()` is false (`apps/api/src/ws/router.ts`).
- Client: auto-ask is gated (`use-live-table.ts`: expert `coachDuringHand = false`).
- Tests: `apps/api/test/ws-router.test.ts` “refuses on expert”; educational table still receives a report. These ran inside `pnpm run verify`.
- Live: `POST /legends/matches` with `difficulty: expert` returned `coachAvailable: false` (`{SCRATCH}/expert-coach-live.log`).

A live `requestCoach` probe was attempted; the first hello/startHand frames used ids that failed `REQUEST_ID_PATTERN` (`^[A-Za-z0-9_-]{8,64}$`). That is a probe defect, not a Coach leak. The in-process test drives the real router.

### Hidden information / server authority

Unchanged and gated: smoke hidden-info WS scan, `hidden-information-api.test.ts`, engine/math exhaustive + invariants, redaction-by-construction. No client-side oracle was introduced.

---

## Screen-reader evidence

**Result: `UNVERIFIED`**

Tool attempted: **VoiceOver** on this macOS host. NVDA: not applicable. Orca: not installed.

Log: `{SCRATCH}/screen-reader.log` (2026-08-20T14:32:31Z).

| Probe | Result |
| --- | --- |
| `/System/Library/CoreServices/VoiceOver.app` | present |
| VoiceOver process at start | none |
| `tell application "System Events" to get name` | `System Events` in 0.40s |
| `tell application "VoiceOver" to get name` | `VoiceOver` in 0.07s |
| `get enabled` | **TIMEOUT 6s** |
| `get content of last phrase` | **TIMEOUT 6s** |
| `output "screen reader probe"` | **Not authorised to send Apple events to VoiceOver. (-1743)** |
| `set enabled to true` | **Can’t set enabled to true. (-10006)** |
| System Events `key code 96` (Cmd+F5) | **TIMEOUT 6s** |
| System Events UI of process VoiceOver | **TIMEOUT 6s** |
| `nvda` / `orca` | not found |
| Shortcuts matching voice/access/speak/reader | none of 9 |

**Journeys completed with a real screen reader: none.**

No announcements were captured for:

- headings / navigation
- cards and hidden-card state
- turn changes
- pot / stacks
- legal actions
- Coach updates
- validation / errors
- hand completion
- dynamic focus / state changes

`test:a11y`, `live-regions.test.ts`, and `keyboard-audit.mjs` are **not** this gate. They are recorded above as separate PASSes.

**Mandatory UNVERIFIED ⇒ cannot declare `RELEASE CANDIDATE: PASS`.**

To close this gate: enable VoiceOver (or NVDA) with Automation + Accessibility TCC for the agent, then complete the six journeys and capture last-phrase / caption logs.

---

## Security status (this SHA’s artifacts)

| Check | Result | Evidence |
| --- | --- | --- |
| Dependencies + transitive graph | PASS | `security:audit` lockfile 162 versions; SBOM 170 components |
| Malware / IOC denylist | PASS | Shai-Hulud IOC sweep + deny-list |
| Lifecycle-script restrictions | PASS | dep-shapes + `ignoreScripts` policy |
| SBOM | PASS | CycloneDX 1.6, this SHA’s graph |
| OSV | PASS | 0 advisories |
| Container pinning | PASS | Dockerfiles and compose images digested |
| Container build | PASS | images above; **no container CVE scanner was run this pass** (not in `verify`) |
| Secret scan | PASS as repo hygiene of this tree; `.env` is gitignored | `security:hygiene` |
| CSP (running web image) | PASS | `{SCRATCH}/csp-container.log` |
| CORS / CSRF / cookies | PASS in API tests + smoke | `verify` + smoke-1/2 |
| HSTS | sent in production `NODE_ENV` only (by design). Local recert API ran `NODE_ENV=development`; HTML origin was HTTP | tests exist; not observed on loopback HTTP |
| WebSocket origin / auth | PASS in tests + smoke | close 4406 / 4401 paths |
| Rate limiting | PASS | smoke §12 429; immediate smoke-2 429 is the same limiter |
| Authorization | PASS | stranger hand 404; restore-DB GET of another user’s room 404 |
| Hidden-card / future-deck isolation | PASS | smoke WS scan |
| Expert live Coach | PASS (tests + `coachAvailable: false` on the wire) | see above |

**Not done on the final images:** a dedicated container vulnerability scan (Trivy/Grype/etc.). That is a remaining P2 for production promotion, not a failed `verify` gate.

---

## Backup / restore evidence

Log: `{SCRATCH}/backup-restore.log`.

**Procedure actually run (does not overwrite the live database):**

1. `pg_dump -Fc` of `poker_risk_lab` inside the compose Postgres container.
2. `CREATE DATABASE poker_risk_lab_restore_probe`.
3. `pg_restore --exit-on-error` into that database — **exit 0**.
4. Ownership: schema `prl` and **54** relations owned by **`prl_migrator`** (not the runtime login).
5. `DATABASE_URL` pointed at the restore DB (runtime role `prl_api`) → `pnpm`/script `verify-schema.mjs` **exit 0**.
6. API process on `:3011` against the restore DB:
   - `GET /api/v1/health` → 200 `{"status":"ok",…}`
   - `GET /api/v1/ready` → 200 `{"status":"ready","checks":{"database":{"ok":true}}}`
   - `GET /api/v1/auth/session` → 200
   - new guest `GET /rooms/:existingId` → **404** `room_not_found_or_not_permitted` (the restored room is not this guest’s; authorization held)

This is a serving restore of a **copy**. It is not a documented RPO/RTO, not a scheduled backup, and not a rehearsal of restoring *over* the live cluster.

**RPO/RTO:** not defined in `docs/RUNBOOK.md` (grep: no matches). Remaining P1 for operations.

---

## Load-test results

Log: `{SCRATCH}/load-test.log`. Harness: `scripts/load-test.mjs`.

**Environment (must be quoted with any number):** one Node API process, same machine as the generator, loopback, development `NODE_ENV`, no proxy, no TLS, no other tenants. The harness’s own footer: *“This measured a local development server over loopback. It is a regression check, not a capacity measurement.”*

| Setting | Value |
| --- | --- |
| tables × seats × hands | 1 × 2 × 3 |
| wall | 0.11 s |
| sessions / rooms / joins | 2 / 1 / 1 |
| connections | 2/2 established |
| hands completed | 3/3 |
| actions sent / applied | 19 / 18 |
| action RTT p50 / p90 / p99 / max | 0.26 / 0.88 / 1.45 / 1.45 ms (n=18) |
| throughput | 1353 server messages/s, 161 actions/s |
| errors | none (0.000% of 27 operations) |
| exit | 0 PASS |

**Not measured:** p95 (harness emits p50/p90/p99), process memory, CPU, event-loop lag, DB pool pressure, worker saturation.

**Path coverage:** join → sit → play hands. The harness does **not** drive Coach, disconnect/reconnect, or hand review. Those are required for a production-capacity claim and were not executed. **No concurrent-user capacity figure is stated.**

Bottleneck on this run: none visible; the generator and server share a loopback CPU, so the numbers cannot be read as headroom.

---

## Observability coverage

Log: `{SCRATCH}/observability.log`. Scraped from running processes this session.

| Required signal | Present as actionable telemetry? | What was actually observed |
| --- | --- | --- |
| HTTP errors / latency | **partial** | pino `incoming request` / `request completed` with `responseTime` and `statusCode`. No histogram, no SLO, no alert. |
| WebSocket connect / disconnect | **partial** | `websocket hub closed` on shutdown. No connection-count metric. |
| Table / hand failures | **partial** | structured `request rejected`; bot restore warn. No dedicated hand-failure counter. |
| DB health / pool pressure | **partial** | `/ready` pings the DB (`checks.database.ok`). No pool wait/saturation metric. |
| Event-loop lag | **missing** | not logged, not exported |
| Simulation worker saturation | **missing** | worker pool exists; no saturation metric |
| Auth / rate-limit failures | **partial** | 429 is an HTTP status in logs when it happens; no dedicated counter/alert |
| Process restarts | **partial** | `listening` / `shutting down` / `shutdown complete` lines. No restart counter or supervisor event. |
| `/metrics` | **missing** | `GET /metrics` and `/api/v1/metrics` → **404** |

**Health/readiness (live):** `/api/v1/health` 200 from memory; `/api/v1/ready` 200 with DB ping. Rate-limit exempt on liveness only.

**Alerts:** none defined (no Prometheus/Grafana/PagerDuty/runbook alert list with thresholds). Collecting pino lines is not an alerting system.

Example restore warn captured:

```
{"level":40,"roomId":"room_6wwydmeezvuaylfgjbfv24fvig","seat":1,"botProfile":"unknown",
 "reason":"the row predates migration 0003 and its strategy profile was destroyed at write time",
 "msg":"a bot seat could not be restored and will not act"}
```

---

## Deployment / rollback verification

**Not demonstrated.** Remaining P1.

What exists:

- CI (`.github/workflows/ci.yml`, `supply-chain.yml`): pinned actions, supply-chain first, no deploy job, `permissions: contents: read`, no secrets.
- Images: built once this session (`docker compose build api web`). They were **not** promoted through a staging environment. There is no in-repo production-equivalent staging stack (compose is a developer machine; `NODE_ENV=development` on the API service, plaintext loopback).
- Rollback: migrations are roll-forward only (`migrate.mjs down` refuses). Application rollback would be “run the previous image”. That procedure was **not** executed.

No “build once → security gates → staging smoke/E2E → promote the same digest → rollback” pipeline was run.

---

## Soft-launch checklist

| Item | Status | Evidence |
| --- | --- | --- |
| Responsible-use content | **PASS (content)** | Footer + home: not a gambling product; no cash-out. `docs/PRODUCT-GUARDRAILS.md` |
| Valueless learning units | **PASS** | Units badge + footer + `POST /me/units/reset`; no currency |
| Public matchmaking | **disabled (PASS)** | `rooms_visibility_invite_only CHECK (visibility = 'invite_only')` on the live DB; ADR 0010 |
| Moderation / anti-abuse before matchmaking | **N/A until matchmaking is proposed** | Constraint still in force; do not enable |
| Age-gate | **MISSING** | No age-gate route, cookie, or config found in `apps/web` |
| Terms of use | **MISSING** | No `/terms` page or production document |
| Privacy policy | **MISSING** | No `/privacy` page or production document |
| Privacy / data deletion | **PARTIAL** | Units can be reset. There is **no** account/data deletion API for a guest’s lessons, hands, or profile |
| AI Legend name/likeness legal review | **requirement recorded, not performed** | `packages/poker-ai/src/labelling.ts`: production default `archetype`; `PRL_LEGEND_NAMING=attributed` is an explicit opt-in that a deployer must not flip without legal review. This recertification did **not** obtain that review |

Public matchmaking was **not** enabled.

---

## Reliability drills (this pass)

| Drill | This pass | Notes |
| --- | --- | --- |
| SIGTERM graceful shutdown | **PASS (tests + live)** | `apps/api/test/shutdown.test.ts` in `verify`; live SIGTERM of PID 10989 freed :3001 in ~5ms; `shutting down` / `shutdown complete` logged |
| Restart / rehydrate 12 Legends | **PASS** | above |
| PostgreSQL backup AND restore | **PASS (copy DB)** | serving `/health`+`/ready` on restore; not a live-cluster overwrite |
| Temporary DB failure | **NOT RUN** | `/ready` degraded vs `/health` alive is tested in-process (`health and readiness` in `verify`); live pause of Postgres was not performed |
| Process kill during an **active** hand | **NOT RUN** | SIGTERM was after match create, not mid-hand |
| Worker failure | **NOT RUN** | shutdown-with-worker-thread is in `shutdown.test.ts`; a live worker crash was not injected |
| Migration failure path | **in-repo tests only** | `migrate.mjs` refuses `down`, checksum mismatch, irreversible DDL without marker — not re-drilled against a broken file this pass |

---

## Remaining issues

### P0

1. **Screen-reader verification UNVERIFIED.** Mandatory. Blocks `RELEASE CANDIDATE: PASS`.

### P1 (production / soft-launch; do not treat as RC-passing excuses)

1. No production-equivalent staging environment, and no promote-the-same-digest pipeline.
2. No metrics + alerts for HTTP latency, WS lifecycle, table/hand failure, DB pool pressure, event-loop lag, worker saturation, auth/rate-limit, process restarts.
3. RPO/RTO not defined; backups are a documented procedure plus one copy-restore rehearsal, not a scheduled restore-with-RTO.
4. Age-gate missing.
5. Terms and Privacy pages/documents missing.
6. No personal-data deletion path (only valueless-unit reset).
7. Load path does not include Coach + disconnect/reconnect + review; no capacity number is defensible.
8. Container image CVE scan not run on the images built this session.
9. Temporary DB outage, mid-hand process kill, and live worker-failure drills not executed this pass.

### P2

1. `style-src-attr 'unsafe-inline'` residual on CSP.
2. `/metrics` 404.
3. OIDC flow UNVERIFIED (not configured on this stack).
4. Load harness does not emit p95, memory, CPU, event-loop lag, or DB/worker saturation.
5. Prior residual: stored Legend-hand comparison still has null `modelReasoning` / decision weights (copy was corrected on this SHA; the live payload still cannot show sampled weights that were never stored).

### P3

1. HSTS and `__Host-` cookies only in production `NODE_ENV` over HTTPS (correct; not observed on this HTTP loopback).
2. `PRL_LEGEND_NAMING=attributed` must not be enabled without legal review of name/likeness.

---

## Residual risks

- **Accessibility:** a screen-reader user may be blocked or misled in ways axe and keyboard Tab cannot see (live-region timing, card names, hidden-card state, Coach sheet on a narrow viewport). Code inspection is not a substitute.
- **Operations:** a production outage would be diagnosed from pino JSON and `/health`/`/ready` only. There is no alert that pages a human.
- **Legal / trust:** shipping attributed Legend names, or collecting identifiable learner data without Terms/Privacy/deletion/age-gate, is a product-legal risk independent of poker correctness.
- **Capacity:** unknown. Loopback p99 ≈ 1.5 ms on 18 samples is not a production SLO.
- **Single API process:** live table state is in-process (ADR 0001). A crash mid-hand still drops the in-memory hand even if bots rehydrate; that is an accepted architecture, not a hidden one.

---

## Production recommendations

1. **Do not ship a release candidate** until a real VoiceOver+Safari (or NVDA) walk is captured for the six journeys, including the announcement list in the objective.
2. After that PASS, treat Phase 2 as a separate hardening milestone: staging compose/k8s with TLS and the **same** image digests, scrapeable metrics + three or four alerts that page, scheduled backup **and** restore with written RPO/RTO, age-gate + Terms/Privacy + deletion, and a load generator that includes Coach, reconnect, and review — labelled with the measurement environment.
3. Keep `rooms_visibility_invite_only`. Do not enable public matchmaking.
4. Keep `PRL_LEGEND_NAMING` unset (`archetype`) until legal review of attributed names exists in writing.
5. Keep Expert Coach as a **socket refusal**, not a UI-only hide.
6. Do not quote `{SCRATCH}/load-test.log` as concurrent-user capacity.

---

## Material assumptions

- Recertification used the developer `.env` and compose Postgres already running on this machine. `NODE_ENV` for the API process was `development` (compose/dev secret posture). The **web** production entry and the **web OCI image** were production `NODE_ENV`.
- Guest rate-limit is 10 / 60s, address-keyed. Two `--strict` smokes in the same window will 429; isolation requires waiting out that window (or a new API process).
- VoiceOver Automation/Accessibility TCC is not granted to this agent; that is why the screen-reader gate is UNVERIFIED rather than FAIL-with-bad-announcements.
- No application source was modified to obtain these results. This document is the only intended tree change from this recertification.

---

## Final verdict

**`RELEASE: FAIL`**
