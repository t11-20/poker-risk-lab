> **Lead freeze, 2026-08-19.** Independent first-pass by the named reviewer at HEAD `f20bbad`. Subsequent P1 remediations are recorded in `docs/audit/final-traceability.md` and `docs/audit/final-release-report.md`. This file is the reviewer's own evidence, not a clearance.

# Reviewer H — Production / SRE audit

**Date:** 2026-08-19  
**HEAD:** `f20bbad2f082e9fe135ce98070da16eff7cc3f14` (`f20bbad`)  
**Auditor:** independent (did not build this; did not read `docs/audit/*.md` as evidence; did not modify application source)  
**Clean tree:** `/tmp/prl-audit-h-clean` (rsync of the repo excluding `node_modules`, `dist`, `.next`, coverage, `.env`)  
**Shared postgres:** left running at `127.0.0.1:5432` (`poker-risk-lab-postgres-1`). **Not** stopped or reset.  
**Isolated postgres:** Docker Compose project `prl-audit-h`, host port **55432**, volume `prl-audit-h_postgres-data`.

Verdict: **PASS with findings.** API/web start from a frozen, script-disabled install; migrations and seed work on an empty database; graceful shutdown for WebSocket **and** raw TCP is independently rechecked and does **not** hang; health tells the truth when the isolated database is stopped; both Dockerfiles build; images are non-root with healthchecks and no baked secrets.

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 0 |
| P2 | 1 |
| P3 | 4 |

---

## Requirement table

| ID | Result | Evidence (this run) |
| --- | --- | --- |
| **OPS-001** Frozen, script-disabled install from the lockfile (clean tree) | **PASS** | `/tmp/prl-audit-h-clean`: `pnpm config get ignore-scripts` → `true`; `pnpm-workspace.yaml` `ignoreScripts: true` + `onlyBuiltDependencies: []`; `pnpm install --frozen-lockfile --ignore-scripts` exit **0** in 3.2s; lockfile unchanged vs workspace; install log has **no** lifecycle/preinstall/postinstall/prepare lines. |
| **OPS-002** `.env.example` complete; secrets validated at boot (production refuses placeholders) | **PASS** | Example keys cover every `config.ts` input (set or commented). Production boots: placeholder secret **exit 78**; missing secret **exit 78**; plaintext `http://` origin **exit 78**; `COOKIE_SECURE=false` **exit 78**. See §Boot refusals. |
| **OPS-003** Migrations from empty: ordered, idempotent, status, rollback story | **PASS** | Empty DB on 55432: `status` showed 2 pending / 0 applied; `up` applied `0001` then `0002`; second `up` → `up to date`; `status` → 2 applied and matching. `node apps/api/scripts/migrate.mjs down` **refuses** with the roll-forward policy (exit 1). `seed`/`reset` refuse under `NODE_ENV=production`. |
| **OPS-004** Seed runs, is idempotent, produces usable content | **PASS** | First seed created `prl_api`/`prl_deployer` + fixture rows; second seed exit 0 (no errors). Usable: 4 users, 1 room, 1 hand; smoke test then served 17 lessons / 36 scenarios / 90 glossary terms from `@prl/content` (content is packaged JSON, not SQL). |
| **OPS-005** Web app starts from the clean install | **PASS** | `next dev --port 4500 --hostname 127.0.0.1` Ready in 358ms. `GET /` **200** (63 609 bytes, title “Poker Risk Lab…”). `GET /learn` **200**. |
| **OPS-006** API starts from the clean install | **PASS** | `PORT=4501 node --env-file=.env apps/api/src/server.ts` (after `pnpm run build:packages`). Listening `http://127.0.0.1:4501`. |
| **OPS-007** WebSocket serves a live table from the clean install | **PASS** | `pnpm run test:smoke -- --origin http://127.0.0.1:4501`: upgrade succeeded, Alice sat, **a hand was played to completion against a bot (37 frames)**. 44/44 checks. |
| **OPS-008** Persistence across restart | **PASS** | Guest `usr_fxemym7as3xnrht77yps25may3` + room `room_vsdi7ky75q55tqldegtqpzqwcs` written to Postgres. SIGTERM API (exit 0, `shutdown complete`). Restart. Same cookie → session user matches; `GET /rooms/:id` **200**, room still `open`. |
| **OPS-009** Health / readiness tell the truth under dependency failure | **PASS** | Isolated postgres **stopped** (shared 5432 left healthy). `/api/v1/health` **200** `{status:"ok"}` in 0.8 ms. `/api/v1/ready` **503** `{status:"degraded", checks.database.ok:false, detail:"database did not answer"}` in 4.3 ms. Production process on :4502 also **503**. After `docker start prl-audit-h-postgres-1`, ready returned **200**. |
| **OPS-010** Graceful shutdown SIGTERM for HTTP **and** WebSocket | **PASS** (rechecked) | See §Shutdown transcripts. WS at a table: **exit 0 in 9.8 ms**, close **4503** `server shutting down`. Idle HTTP: **exit 0 in 7.5 ms**. In-flight / incomplete HTTP: exit 0, no grace-timeout. |
| **OPS-011** Graceful shutdown for raw TCP (no HTTP/WS handshake) | **PASS** (rechecked) | Raw `net.Socket` connect, send nothing, SIGTERM: **exit 0 in 31.2 ms**, TCP `close` observed, **did not** wait the 8 s grace. Incomplete HTTP body: **exit 0 in 1019 ms** (matches `clientSendGraceMs` = 1 s cap), not the full grace. |
| **OPS-012** `pnpm run build` for apps from clean | **PASS** | Clean tree `pnpm run build` exit **0** (packages + `tsc` API + `next build` web, ~6 s). |
| **OPS-013** `Dockerfile.api` and `Dockerfile.web` actually build | **PASS** | `docker build -f Dockerfile.api -t prl-audit-h-api:local` exit 0 (~35 s). `docker build -f Dockerfile.web -t prl-audit-h-web:local` exit 0 (~55 s). Both `--frozen-lockfile --ignore-scripts`. |
| **OPS-014** Container security: non-root, no baked secrets, healthcheck | **PASS** | API image `User=node` uid **1000**; web image `User=node` uid **1000**; proxy image `User=101`. Both app images: `HEALTHCHECK` exec-form `node -e fetch(os.hostname()…)`. `docker run` API: `id` = uid 1000, no `.env` in image, no `SESSION_COOKIE_SECRET` in image env, healthcheck → **healthy**, `/health` 200 `/ready` 200. Compose: `read_only`, `cap_drop: ALL`, `no-new-privileges`, `init: true`. API serving image **omits** `apps/api/scripts` (cannot migrate). |
| **OPS-015** Restart / recovery mid-hand documented and observed | **PASS** (with P3 note) | Documented: `docs/RUNBOOK.md` §11.1, `apps/api/src/rooms/registry.ts`. Observed: hand `hand_h6s5xeaiim3r7axjlwuy6oiqrj` left `preflop` / `completed_at IS NULL`; after restart **before reopen** still open; after WS `hello` → `street=complete`, `result.abandoned=true`, `abandonedReason=interrupted-by-restart`. Room reopened (`welcome`). Live in-memory table is gone; durable room/session remain. Abandon runs on **room reopen**, not process boot (see P3-3). |
| **OPS-016** `docs/RUNBOOK.md` works as written | **PASS** with P2/P3 | Default first-run path is coherent (install, `.env`, secret, `db:setup`, `dev`). Followed it in the clean tree against an isolated DB. Gaps: `db:wait` does not load `.env` (P2-1); compose interpolates `SESSION_COOKIE_SECRET` even for postgres-only; `pnpm run db:migrate -- down` does not run `down` because the npm script hardcodes `up` (runbook itself shows the `node … migrate.mjs down` form). |
| **OPS-017** Production-style startup (`NODE_ENV=production`, real secret) | **PASS** | `:4502` with `NODE_ENV=production`, generated secret, `PUBLIC_WEB_ORIGIN=https://app.example.test`. Listening, `nodeEnv: production`, HSTS present. `/health` 200 `/ready` 200. Same image `docker run` with production env also served. Placeholder/http/COOKIE_SECURE refusals in §Boot refusals. |
| **OPS-018** One-API-process / in-memory room constraint documented | **PASS** | `docs/RUNBOOK.md` §11.1; `apps/api/src/rooms/registry.ts` (“authoritative live state is this process's memory … one API process per room”); `docker-compose.yml` `deploy.replicas: 1` with the same reason. |
| **OPS-019** `db:verify` asserts live schema security properties | **PASS** | Against isolated DB as `prl_api`: 118 columns, 41 indexes, 12 tables visible to runtime role, schema/relation owner check, **exit 0** “every documented schema security property holds”. Check 6b in `verify-schema.mjs` asserts `prl_migrator` ownership. |
| **OPS-020** Release suite commands exist and are documented | **PASS** | Root scripts: `verify`, `test:smoke`, `test:load`, `db:verify`. Documented in RUNBOOK §3 and §11.7. This run executed `test:smoke` (44 pass) and `db:verify` (pass). Full `pnpm run verify` **not** re-run here (multi-minute suite; out of scope for this SRE pass). |

---

## Method

1. Read `docs/RUNBOOK.md`, `apps/api/src/server.ts`, `apps/api/src/config.ts`, `apps/api/src/app.ts` (`/health` `/ready`), `apps/api/src/ws/hub.ts` (`preClose`), `apps/api/src/rooms/registry.ts`, `apps/api/scripts/migrate.mjs`, `apps/api/scripts/verify-schema.mjs`, `docker-compose.yml`, `Dockerfile.api`, `Dockerfile.web`, `pnpm-workspace.yaml`, `.env.example`, `scripts/db-wait.mjs`, `scripts/dev.mjs`, `package.json`.
2. Rsync to `/tmp/prl-audit-h-clean` (no `node_modules` / `dist` / `.next` / `.env`).
3. Isolated Compose: `SESSION_COOKIE_SECRET=… POSTGRES_PORT=55432 docker compose -p prl-audit-h up -d postgres`. Shared `poker-risk-lab-postgres-1` on 5432 remained **healthy**.
4. Frozen install + package build in the clean tree; API `PORT=4501`, web `PORT=4500`, production API `PORT=4502`.
5. Mandatory SIGTERM harness in `/tmp/prl-audit-h-shutdown.mjs` spawning **new** API processes (grace 8000 ms), not the long-lived 4501 server.

Node **v24.18.0**, pnpm **11.10.0**, Docker **29.6.1**, Compose **v5.2.0**.

---

## OPS-001 — Clean frozen install

```
cd /tmp/prl-audit-h-clean
node --version    # v24.18.0
pnpm --version    # 11.10.0
pnpm config get ignore-scripts    # true
pnpm install --frozen-lockfile --ignore-scripts --reporter=append-only
```

Install log (complete):

```
Scope: all 9 workspace projects
✓ Lockfile passes supply-chain policies (verified 1d ago)
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +104
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 104, reused 104, downloaded 0, added 104, done

devDependencies:
+ @biomejs/biome 2.5.7
+ @types/node 24.13.3
+ axe-core 4.13.0
+ typescript 7.0.2

Done in 3.2s using pnpm v11.10.0
```

- `ignoreScripts: true` and `onlyBuiltDependencies: []` in `pnpm-workspace.yaml` (pnpm 11 reads policy here, not `.npmrc`).
- CLI `--ignore-scripts` as belt-and-braces (same as both Dockerfiles).
- No `Running lifecycle scripts` / `preinstall` / `postinstall` / `prepare` lines.
- `pnpm-lock.yaml` identical to the workspace copy.
- Workspace packages have **no** `dist/` until `pnpm run build:packages` (required: `@prl/*` exports resolve to `dist/`).

---

## OPS-002 — `.env.example` and production secret refusals

`.env.example` documents API, web, migration, and compose variables. Every key `config.ts` reads is present (set or commented). `SESSION_COOKIE_SECRET` in the example is explicitly a value production **refuses**.

### Boot refusals (clean tree, `apps/api/src/server.ts`)

| Case | Exit | Message (abridged) |
| --- | ---: | --- |
| `NODE_ENV=production` + example `SESSION_COOKIE_SECRET=replace-me-this-example-value-is-rejected-in-production` | **78** | `SESSION_COOKIE_SECRET looks like a placeholder (it contains "example")` |
| `NODE_ENV=production`, secret unset | **78** | `SESSION_COOKIE_SECRET is required in production; generate one with node -e "…randomBytes(32)…"` |
| `NODE_ENV=production` + `PUBLIC_WEB_ORIGIN=http://localhost:3000` | **78** | plaintext http; Secure cookie would never be sent |
| `NODE_ENV=production` + `COOKIE_SECURE=false` | **78** | `COOKIE_SECURE=false is not allowed in production` |

Compose: `SESSION_COOKIE_SECRET: '${SESSION_COOKIE_SECRET:?missing. Put a generated value in .env …}'` — `docker compose up` without it fails interpolation (observed when starting postgres-only without a dummy; see P3-1).

---

## OPS-003 / 004 / 019 — Empty database, migrate, seed, verify

Target: `postgresql://poker:poker-dev-only@127.0.0.1:55432/poker_risk_lab` (migration) and `prl_api` (runtime / `db:verify`).

**Status on empty DB:**

```
  ! prl.schema_migrations does not exist yet — nothing has been applied to this database
  pending  0001_initial.sql
  pending  0002_indexes_and_constraints.sql
  · 2 pending, 0 applied
```

**First `up`:**

```
Applying 2 migration(s)
  · postgres: created role prl_migrator
  · postgres: created role prl_app
  ✓ 0001_initial.sql (47 ms, a9a5cce35ad5)
  ✓ 0002_indexes_and_constraints.sql (26 ms, 0283c0c4a0da)
  · ledger ownership moved from "poker" to prl_migrator
```

**Second `up`:** `✓ up to date — 2 migration(s) applied, nothing pending`  
**Status after:** both files `applied`, `2 applied and matching, 0 pending`.

**`down` (policy, not a missing command):**

```
$ node --env-file-if-exists=.env apps/api/scripts/migrate.mjs down ; echo $?
  ✗ There is no `down`. Poker Risk Lab is roll-forward only, and this is the policy, not a
missing feature.
  ...
1
```

(`pnpm run db:migrate -- down` is **not** equivalent: the npm script is hardcoded `… migrate.mjs up`, so it becomes `up -- down` → `Unknown option "--"`. RUNBOOK §11.3 shows the `node … down` invocation.)

**Seed:** first run created login roles `prl_api` / `prl_deployer` (password `poker-dev-only`, `NOLOGIN` privilege roles unchanged). Second seed exit 0.  
`NODE_ENV=production` seed: `seed will not run with NODE_ENV=production` (exit 1). Reset likewise refused.

**Live content after seed:** `prl.users` 4, `prl.rooms` 1, `prl.hands` 1; roles `prl_api` LOGIN, `prl_app` NOLOGIN, `prl_deployer` LOGIN, `prl_migrator` NOLOGIN. Lessons/glossary come from `@prl/content` (smoke: 17 / 90).

**`pnpm run db:verify`** (as `prl_api` via `.env`):

```
  · 118 columns across the prl schema
  · 41 indexes
  · checked 12 tables for prl_app privileges
  · checked schema and every relation owner
  ✓ every documented schema security property holds
```

Superuser listing of `prl` relations is **13** tables (includes `schema_migrations`, which `prl_api` cannot see). RUNBOOK §11.4 quotes 121 columns / 13 tables — docs drift, not a verify failure (P3-2).

---

## OPS-005 / 006 / 007 / 012 / 017 — Start and build

| Process | Command | Result |
| --- | --- | --- |
| Packages | `pnpm run build:packages` in clean tree | exit 0; `packages/*/dist` present (`ui` is source-only) |
| Apps | `pnpm run build` | exit 0; API `tsc`; Next.js 16.3.0 production build, 12 routes |
| API dev | `PORT=4501 HOST=127.0.0.1 node --env-file=.env apps/api/src/server.ts` | `listening` on `:4501` |
| API prod | `NODE_ENV=production PUBLIC_WEB_ORIGIN=https://app.example.test PORT=4502 …` | `nodeEnv: production`; HSTS `max-age=31536000; includeSubDomains` |
| Web | `pnpm --filter @prl/web exec next dev --port 4500 --hostname 127.0.0.1` | Ready 358 ms; `/` 200 |

**Smoke** (`PRL_WEB_ORIGIN=http://localhost:3000 node scripts/smoke-test.mjs --origin http://127.0.0.1:4501`):

```
  ✓ health responds version 0.1.0, protocol 1
  ✓ readiness passes database ok
  … guest, CSRF, 17 lessons, 36 scenarios, 90 glossary terms …
  ✓ the WebSocket upgrade succeeded session cookie carried on the handshake
  ✓ Alice took a seat over the socket
  ✓ a hand was played to completion against a bot 37 frames
  …
Summary
  44 check(s) passed
Smoke test passed.
```

---

## OPS-008 / 015 — Persistence and mid-hand recovery

**Persist**

- Created guest `usr_fxemym7as3xnrht77yps25may3`, room `room_vsdi7ky75q55tqldegtqpzqwcs` (status `open`).
- SIGTERM pid 22187 (the :4501 API):

```
{"reason":"SIGTERM","msg":"shutting down"}
{"msg":"websocket hub closed"}
{"reason":"SIGTERM","msg":"shutdown complete"}
```

Process **exited**; port freed; restarted on 4501.

- After restart, same session cookie: `sessionUser` matches, `sessionMatches: true`.
- `GET /api/v1/rooms/room_vsdi7ky75q55tqldegtqpzqwcs` **200**, still `open`, members (human + bot) intact.

**Mid-hand**

- Dealt `hand_h6s5xeaiim3r7axjlwuy6oiqrj`, street `preflop`. DB: `open=t`, `no_result=t`.
- Kill + restart API.
- **Before** the next `hello`: still `preflop`, not abandoned.
- **After** WS `hello` / `welcome` (room reopened via `registry.ensureOpen` → `open()` → `reconcileInterruptedHands`):  
  `street=complete`, `abandoned=true`, `reason=interrupted-by-restart`.

This matches ADR/runbook: the deck is not persisted; the in-progress hand cannot resume; history is closed as abandoned when the room is next opened. There is **no** boot-time sweep of rooms nobody reopens (P3-3).

---

## OPS-010 / 011 — Graceful shutdown (mandatory recheck)

Harness: `/tmp/prl-audit-h-shutdown.mjs` spawning `apps/api/src/server.ts` from the clean tree with `SHUTDOWN_GRACE_MS=8000` (in-flight compute case 25000). Clients: `ws` package (API’s own dependency) and `net.Socket`. A hang would be ~8000 ms + `process.exit(1)` / `shutdown timed out`.

### Transcripts

| Case | Exit code | Signal | Elapsed | `shutdown complete` | `shutdown timed out` | Client observation |
| --- | ---: | --- | ---: | --- | --- | --- |
| Idle (GET /health then SIGTERM) | **0** | none | **7.5 ms** | yes | no | — |
| WebSocket **at a table** (`hello` + `welcome`) | **0** | none | **9.8 ms** | yes | no | close **4503** reason `server shutting down` |
| WebSocket **open, no hello** (upgraded, not in a room) | **0** | none | **8.2 ms** | yes | no | close **4503** reason `server shutting down` |
| **Raw TCP**, connect, send **nothing** | **0** | none | **31.2 ms** | yes | no | TCP `close`; **not** a full-grace wait |
| Incomplete HTTP (headers + partial body, `Content-Length: 4096`) | **0** | none | **1019 ms** | yes | no | matches `clientSendGraceMs` = min(1000, grace/4); then socket destroy |
| Keep-alive Monte Carlo then SIGTERM | **0** | none | **3274 ms** | yes | no | HTTP **200**; ~18–29 ms after last byte (worker-pool close, not 72 s keep-alive) |

Long-lived :4501 SIGTERM (persist test, no live sockets): ~13 ms `shutting down` → `shutdown complete`.

**Raw TCP did not hang.** This was the previously known class of defect (`server.close()` waiting on a connection that never became a request). Independent measurement: **31 ms / exit 0**, vs an 8000 ms grace. Mechanism: `trackConnections` + `drainIdleConnections` in `apps/api/src/server.ts` destroying non-blocking sockets on a 25 ms sweep.

**WebSocket close code is 4503**, not 1006. Hub `preClose` (`apps/api/src/ws/hub.ts`) sends `WS_CLOSE.serverShuttingDown` before `server.close()`. Observed on both a welcomed table socket and a socket that never sent `hello`.

The in-flight compute request on this machine finished before SIGTERM (`answeredBeforeSignal: true`) even at 20 ms; it is **not** a hang. Combined with the incomplete-body case (1.0 s bounded wait) and idle keep-alive drain (7.5 ms), HTTP shutdown is sound.

---

## OPS-009 — Health under isolated DB failure

Shared `poker-risk-lab-postgres-1` **not** stopped.

```
# before
GET /api/v1/health  → 200 {"status":"ok","version":"0.1.0","protocolVersion":1}
GET /api/v1/ready   → 200 {"status":"ready","checks":{"database":{"ok":true}}}

docker stop prl-audit-h-postgres-1
# poker-risk-lab-postgres-1 still: running healthy

GET :4501/api/v1/health → 200  time=0.0008s   (liveness, no DB)
GET :4501/api/v1/ready  → 503  time=0.0043s   {"status":"degraded","checks":{"database":{"ok":false,"detail":"database did not answer"}}}
GET :4502/api/v1/ready  → 503  same body

docker start prl-audit-h-postgres-1
GET :4501/api/v1/ready  → 200 ready
```

Liveness does not lie; readiness is 503 without parsing the body, detail is a fixed non-sensitive string (`db.ts` `ping()`).

---

## OPS-013 / 014 — Images

```
docker build -f Dockerfile.api -t prl-audit-h-api:local .   # exit 0
docker build -f Dockerfile.web -t prl-audit-h-web:local .   # exit 0
```

Both install with `pnpm install --frozen-lockfile --ignore-scripts`.

| Image | User | uid | HEALTHCHECK | Secrets in image env / `.env` files | Notes |
| --- | --- | ---: | --- | --- | --- |
| `prl-audit-h-api:local` | `node` | 1000 | `fetch(http://${hostname}:${PORT}/api/v1/health)` interval 30s | none | `HOST=0.0.0.0`; no `apps/api/scripts` |
| `prl-audit-h-web:local` | `node` | 1000 | `fetch(http://${hostname}:${PORT}/)` | none | `WORKDIR /app/apps/web`; `next start` |
| `nginxinc/nginx-unprivileged:1.29.8-alpine@sha256:0c79…` | `101` | 101 | compose wget to `$(hostname):8080/` | n/a | `cap_drop: ALL` |

`docker run --network prl-audit-h_default` of the API image (`NODE_ENV=production`, generated secret, `PUBLIC_WEB_ORIGIN=https://app.example.test`, DB at `prl-audit-h-postgres-1`): process `id` **uid=1000(node)**; listening on container IP **and** 127.0.0.1; published `:4504` health 200 / ready 200; Docker health **healthy** (start-period then pass). Container removed after the probe; isolated postgres left up for the rest of the audit, then eligible for `compose -p prl-audit-h down` (no `-v` required; **never** `down` on `poker-risk-lab`).

Compose API/web do not duplicate HEALTHCHECK YAML; they inherit the image HEALTHCHECK. `proxy` `depends_on: condition: service_healthy` therefore uses those probes. `stop_grace_period: 30s` vs `SHUTDOWN_GRACE_MS=10000` (margin, not a tie).

---

## OPS-016 / 018 / 020 — Runbook, one-process constraint, release commands

**One API process per room** is explicit in RUNBOOK §11.1, `registry.ts`, and `deploy.replicas: 1`. Web is stateless; Postgres is durable state; live `HandState` is in-process memory. Observed: restart drops the live table; room row and session survive.

**Release commands** (root `package.json`, RUNBOOK §3 / §11.7):

| Script | Present | This run |
| --- | --- | --- |
| `pnpm run verify` | yes (all gates, reports PASS/FAIL each) | not executed (long) |
| `pnpm run test:smoke` | yes | **44 pass** against :4501 |
| `pnpm run test:load` | yes (`scripts/load-test.mjs`) | not executed |
| `pnpm run db:verify` | yes | **pass** on isolated DB |

Default first-run (`install --frozen-lockfile`, copy `.env.example`, generate secret, `db:setup`, `dev`) is executable on a machine whose postgres is the compose default on 5432. This audit used a side project on 55432 rather than `db:up` so as not to reset the shared instance.

---

## Findings

### P0 — none

No start failure, no undisclosed data loss, no SIGTERM hang that prevents restart.

### P1 — none

Raw TCP and WebSocket shutdown both exit 0 well inside grace with a real close frame (WS) or a dropped socket (TCP). Health does not lie. Migrations run from empty. Images are non-root.

### P2

**P2-1 — `pnpm run db:wait` (and therefore `db:setup`) does not load `.env`.**

`package.json`: `db:wait` is `node scripts/db-wait.mjs` (no `--env-file`). `db:migrate` / `db:seed` **do** use `--env-file-if-exists=.env`. `db-wait.mjs` reads `process.env.DATABASE_URL` then defaults to `127.0.0.1:5432`.

Observed from the clean tree with `.env` pointing at **55432**: `pnpm run db:wait` printed `target poker@127.0.0.1:5432/… (from environment)` and succeeded in 0.0 s against the **shared** `poker-risk-lab` instance, not the isolated one.

Impact:

- Custom `DATABASE_URL` / `POSTGRES_PORT` in `.env` only: `db:up` (compose interpolates `.env`) can start Postgres on the new port while `db:wait` blocks on 5432.
- If 5432 is already occupied by another cluster (this machine), wait is a false green.
- If 5432 is closed, `db:setup` can time out for 60 s even though the intended database is ready.

Default first-run (everything on 5432, no `.env` port change) still works. Fix would be `--env-file-if-exists=.env` on `db:wait`, matching migrate/seed. **Not fixed in this audit.**

### P3

**P3-1 — Compose interpolates `SESSION_COOKIE_SECRET` for the whole file.** `docker compose up -d postgres` fails with “required variable SESSION_COOKIE_SECRET is missing” even when only Postgres is requested. Workaround: a dummy for interpolation. Documented for the full stack; surprising for DB-only.

**P3-2 — RUNBOOK internal inconsistency on `db:verify` ownership.** §11.4 describes check **6b** (schema and every relation owned by `prl_migrator`) and this run executed it (`checked schema and every relation owner`). §11.7 checklist still says: “Schema ownership on the restored database checked **by hand** — `db:verify` does not look at it…”. Operators following only the checklist will do redundant work and distrust the gate. Same section’s 121 columns / 13 tables vs live `prl_api` view of 118 / 12 (`schema_migrations` is correctly invisible to the runtime role).

**P3-3 — Interrupted hands are closed on room reopen, not at API boot.** `reconcileInterruptedHands` is called from `RoomRegistry.open()`, which runs when a room is loaded into this process. A hand left `completed_at IS NULL` stays that way until someone opens that room again. Documented in `registry.ts`; RUNBOOK §11.1 says the in-progress hand is lost but does not say the history row stays “open” until reopen. Observed in OPS-015.

**P3-4 — `pnpm run db:migrate -- down` does not invoke the policy command.** The npm script always passes `up`. RUNBOOK §11.3 already shows `node apps/api/scripts/migrate.mjs down`. Easy operator trap; the policy command itself is correct.

---

## Counts

| | |
| --- | ---: |
| Requirements | 20 |
| PASS | 20 (OPS-016 with documented gaps) |
| FAIL | 0 |
| P0 | 0 |
| P1 | 0 |
| P2 | 1 |
| P3 | 4 |

**Independence notes:** previous production PASS/FAIL claims were not used. Shared Postgres on 5432 was not reset or `compose down`’d. Isolated project `prl-audit-h` on 55432 was used for empty-DB proof and for `/ready` under DB failure.

**Processes this auditor started (may be stopped after the report):** API :4501, API prod :4502, web :4500, container `prl-audit-h-api-ctr` (already removed), Compose project `prl-audit-h` postgres. Other listeners observed and **not** touched: `:4100`, `:4101`, `:4201`, `:4300`, `:4301`, shared `poker-risk-lab-postgres-1`.
