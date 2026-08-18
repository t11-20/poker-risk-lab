# Agent G — Data / Production / SRE audit

**Auditor:** Reviewer G (independent principal release auditor)
**Date:** 2026-08-18
**Scope:** clean-environment production path — install, config, migrations, seed, startup,
persistence, health, shutdown, build, images, container security, restart/recovery, runbook.

## Method and isolation

Every result below was produced in an environment isolated from the shared dev instance:

* The repository source was copied (excluding `node_modules`, `dist`, `.next`, `coverage`,
  `*.tsbuildinfo`) to
  `/private/tmp/.../scratchpad/agentG/repo` and **installed there from scratch**, with a private
  pnpm store, so nothing below benefits from a warm root `node_modules`.
* A private PostgreSQL was run as compose project `prl-audit-g` on `127.0.0.1:55432` with its own
  volume, and its database was **empty** at the start of the migration test (verified:
  `0` tables, only the `public` schema, only the `poker` role).
* Host ports used: api `3301`, web/proxy `3300`, postgres `55432`.
* The shared `poker-risk-lab-postgres-1` container, its volume and the shared compose project were
  never touched. Verified after cleanup: still `Up 9 hours (healthy)`, volume
  `poker-risk-lab_postgres-data` intact, project `poker-risk-lab running(1)`.
* All containers, volumes, networks and images I created were removed at the end.

Documentation was read only to extract claims to test. No status below is granted on the strength
of a file existing.

---

## Summary

| ID | Requirement | Status |
| --- | --- | --- |
| OPS-001 | Frozen, script-disabled install from the lockfile, clean checkout | **PASS** |
| OPS-002 | `.env.example` complete and sufficient; secrets validated at boot | **PASS** |
| OPS-003 | Migrations from empty: ordered, idempotent, status, rollback | **PARTIAL** |
| OPS-004 | Seed runs, is idempotent, produces usable content | **PASS** |
| OPS-005 | Web app starts from the clean install | **PASS** |
| OPS-006 | API starts from the clean install | **PASS** |
| OPS-007 | WebSocket serves a live table from the clean install | **PASS** |
| OPS-008 | Persistence across restart; live-schema security; least-privilege DB roles in use | **PARTIAL** |
| OPS-009 | Health / readiness endpoints tell the truth under dependency failure | **PASS** |
| OPS-010 | Graceful shutdown on SIGTERM: drain, close pool, exit 0 in time | **FAIL** |
| OPS-011 | `pnpm run build` for both apps from clean; `packages/ui` dist gap | **PASS** |
| OPS-012 | `Dockerfile.api` and `Dockerfile.web` actually build | **PASS** |
| OPS-013 | Container security: non-root, no baked secrets, caps, read-only, healthcheck | **PASS** |
| OPS-014 | Restart / recovery mid-hand; what is lost; is it handled gracefully | **PARTIAL** |
| OPS-015 | `docs/RUNBOOK.md` works as written for a new operator | **FAIL** |

**Counts:** PASS 10 · FAIL 2 · PARTIAL 3 · UNVERIFIED 0 · N/A 0

---

### OPS-001 Frozen, script-disabled install from a clean checkout

- **Requirement (exact):** A clean checkout must install from the committed lockfile with
  `--frozen-lockfile` and lifecycle scripts disabled, without mutating or regenerating the
  lockfile. A lockfile out of sync with the workspace `package.json` files is a release blocker.
- **Status:** PASS
- **Implementation location:** `pnpm-lock.yaml`; `pnpm-workspace.yaml:24-32` (`ignoreScripts: true`,
  `onlyBuiltDependencies: []`, `minimumReleaseAge: 10080`, `verifyStoreIntegrity: true`,
  `preferFrozenLockfile: true`); `package.json:8` (`packageManager` with sha256).
- **Runtime evidence:**

```
$ rsync -a --exclude node_modules --exclude dist --exclude .next … repo/ scratchpad/agentG/repo/
$ cd scratchpad/agentG/repo && export npm_config_store_dir=…/agentG/pnpm-store
$ node --version && pnpm --version
v24.18.0
11.10.0
$ time pnpm install --frozen-lockfile --ignore-scripts
Scope: all 9 workspace projects
✓ Lockfile passes supply-chain policies (verified 17h ago)
Lockfile is up to date, resolution step is skipped
Packages: +104
Progress: resolved 104, reused 0, downloaded 104, added 104, done
devDependencies:
+ @biomejs/biome 2.5.7
+ @types/node 24.13.3
+ axe-core 4.13.0
+ typescript 7.0.2
Done in 20s using pnpm v11.10.0
real	0m20.141s
INSTALL_EXIT=0
```

  `reused 0, downloaded 104` proves this was a genuinely cold store, not a warm-cache replay.
  `Lockfile is up to date, resolution step is skipped` proves the lockfile matches the nine
  workspace manifests.
- **Test covering it:** `.github/workflows/ci.yml:115,167,201,263,317,390` — every CI job installs
  with `--frozen-lockfile`.
- **Test result:** not executed in CI here; the equivalent command was executed locally, exit 0.
- **Reviewer notes:** Also re-ran the RUNBOOK §2 follow-up gate from the same clean tree:
  `pnpm run security:audit` → all 8 gates pass in 9.7 s, exit 0 (policy, hygiene, denylist,
  shapes, IOC sweep, integrity+release-age over 162 versions, OSV over 162 versions, SBOM with
  170 components). The `verified 17h ago` line is a pnpm cache note, not a substitute for the
  gate; the gate itself was re-run and passed.
- **Missing work:** none.

---

### OPS-002 Environment setup from `.env.example`; boot-time secret validation

- **Requirement (exact):** `.env.example` must be complete and sufficient — the app must start
  from a straight copy of it with no undocumented variable — and required secrets must be
  validated at boot with a clear error rather than silently defaulting to something insecure.
- **Status:** PASS
- **Implementation location:** `.env.example:1-305`; `apps/api/src/config.ts:356-406`
  (`readSessionCookieSecret`), `:492-597` (`loadConfig`, throws `ConfigError` listing every
  problem), `apps/api/src/server.ts:151-165` (exit code 78 = `EX_CONFIG`).
- **Runtime evidence:** copied `.env.example` → `.env` verbatim and changed only the three values
  my port isolation required (`DATABASE_URL` port `5432`→`55432`, `PORT` `3001`→`3301`,
  `PUBLIC_WEB_ORIGIN` `3000`→`3300`). Nothing else was added:

```
$ node --env-file-if-exists=.env dist/server.js
{"level":30,…,"msg":"Server listening at http://127.0.0.1:3301"}
{"level":30,…,"nodeEnv":"development","oidcEnabled":false,
 "allowedOrigins":["http://localhost:3300","http://127.0.0.1:3300"],"routeModules":7,"msg":"listening"}
```

  Production-profile validation, three separate boots with a scrubbed environment (`env -i`):

```
$ NODE_ENV=production … (no SESSION_COOKIE_SECRET) node dist/server.js
Refusing to start: 1 configuration problem.
  - SESSION_COOKIE_SECRET is required in production; generate one with `node -e "…randomBytes(32)…"`
EXIT=78

$ NODE_ENV=production SESSION_COOKIE_SECRET='replace-me-this-example-value-is-rejected-in-production' …
Refusing to start: 1 configuration problem.
  - SESSION_COOKIE_SECRET looks like a placeholder (it contains "example"); generate a real one …
EXIT=78

$ NODE_ENV=production PUBLIC_WEB_ORIGIN=http://localhost:3300 COOKIE_SECURE=false <real secret> …
Refusing to start: 2 configuration problems.
  - PUBLIC_WEB_ORIGIN entry "http://localhost:3300" is plaintext http; a Secure session cookie
    would never be sent to it, so sign-in could not work
  - COOKIE_SECURE=false is not allowed in production: a session cookie without the Secure
    attribute can be read from a single plaintext request
EXIT=78
```

  Variable-coverage diff (names read by `config.ts` and `process.env` across `apps/`,
  `packages/`, `scripts/`, versus names declared in `.env.example`): every variable the server
  reads is declared. Only two undeclared names exist and both belong to the smoke harness
  (`PRL_WEB_ORIGIN`, `PRL_SMOKE_STRICT`, `scripts/smoke-test.mjs:27,39`).
- **Test covering it:** `apps/api/test/config.test.ts`, `apps/api/test/config-origin-shape.test.ts`
- **Test result:** not executed (pure config unit tests; the runtime boots above are stronger
  evidence for this requirement).
- **Reviewer notes:** This is the strongest area of the release. `exit 78` is the correct
  `EX_CONFIG` code, every problem is reported at once, and the placeholder detection actually
  fires on the repo's own example value. Three residual gaps, none blocking:
  1. `POSTGRES_USER/PASSWORD/DB/PORT` are interpolated by `docker-compose.yml:129-138,144` but are
     not declared keys in `.env.example` — they appear only inside a prose comment at
     `.env.example:103-107`. An operator changing the DB password has to infer the key names.
  2. In `development`, a `SESSION_COOKIE_SECRET` that is the published example value is accepted
     with **no warning at all** (`config.ts:375-383` only length-checks outside production). The
     placeholder check is production-only. Anyone running a shared non-production environment
     signs sessions with a value from a public repository and is told nothing.
  3. `PRL_WEB_ORIGIN` / `PRL_SMOKE_STRICT` are undocumented; harness-only, so cosmetic.
- **Missing work:** declare `POSTGRES_*` as real keys; extend the placeholder check to a warning
  outside production.

---

### OPS-003 Database migrations from empty

- **Requirement (exact):** Migrations run from an empty database must apply cleanly and in order,
  be idempotent (safe to run twice), expose a status command, and offer a working rollback/down
  path.
- **Status:** **PARTIAL** — apply/order/idempotency/status all pass; **there is no rollback path
  of any kind**.
- **Implementation location:** `apps/api/scripts/migrate.mjs:94` (`const COMMANDS = ['up',
  'status', 'seed', 'reset']`), `:277-302` (ledger), `:304-350` (advisory lock), `:376-440`
  (drift + out-of-order refusal, one transaction per file); `db/migrations/0001_initial.sql`,
  `db/migrations/0002_indexes_and_constraints.sql`.
- **Runtime evidence:** against an empty database (`0` tables, `public` schema only):

```
$ pnpm run db:migrate:status          # BEFORE
  ! prl.schema_migrations does not exist yet — nothing has been applied to this database
  pending  0001_initial.sql
  pending  0002_indexes_and_constraints.sql
  · 2 pending, 0 applied

$ time pnpm run db:migrate            # RUN 1
Applying 2 migration(s)
  · postgres: created role prl_migrator
  · postgres: created role prl_app
  ✓ 0001_initial.sql (110 ms, a9a5cce35ad5)
  ✓ 0002_indexes_and_constraints.sql (58 ms, 0283c0c4a0da)
real	0m0.675s     MIGRATE_EXIT=0

$ pnpm run db:migrate                 # RUN 2 — idempotency
  ✓ up to date — 2 migration(s) applied, nothing pending      MIGRATE2_EXIT=0

$ pnpm run db:migrate:status          # AFTER
  applied  0001_initial.sql  2026-08-18T12:14:09.705Z
  applied  0002_indexes_and_constraints.sql  2026-08-18T12:14:09.815Z
  · 2 applied and matching, 0 pending
```

  Result: 13 tables in schema `prl`, 121 columns, 41 indexes. Rollback probe:

```
$ node apps/api/scripts/migrate.mjs --help
  up [--allow-missing]   apply pending migrations
  status                 show applied and pending migrations
  seed                   apply db/seeds/*.sql (never with NODE_ENV=production)
  reset                  drop schema prl, then apply every migration again

$ node apps/api/scripts/migrate.mjs down
  ✗ Unknown command "down". Expected one of: up, status, seed, reset.   DOWN_EXIT=1

$ find db -type f
db/migrations/0001_initial.sql
db/migrations/0002_indexes_and_constraints.sql
db/seeds/0001_dev_seed.sql        # no *.down.sql, no rollback directory
```

  Production guards verified as claimed:

```
$ NODE_ENV=production … migrate.mjs reset
  ✗ `reset` will not run with NODE_ENV=production.   EXIT=1
$ NODE_ENV=production … migrate.mjs seed
  ✗ `seed` will not run with NODE_ENV=production.    EXIT=1
```

- **Test covering it:** NONE. There is no test file for `apps/api/scripts/migrate.mjs`;
  `pnpm run test:scripts` globs `scripts/**/*.test.mjs`, which does not include `apps/api/scripts`.
- **Test result:** not executed — no such test exists.
- **Reviewer notes:** The forward path is genuinely good: session advisory lock on a `max: 1`
  pool, one transaction per file, sha256 drift detection, out-of-order refusal, `lock_timeout`
  inside the transaction, and no secret ever printed. The status command is honest about a
  database with no ledger yet. But the only destructive verb is `reset` (drop the whole schema and
  reapply), which is explicitly refused in production — so **there is no way to undo a bad
  migration in production**. `docs/RUNBOOK.md:474` implies a roll-forward-only strategy
  ("Additive-first schema changes make that order safe; a destructive change needs two releases")
  but never states it as the rollback policy, and §11 has no "how to roll back a bad release"
  procedure. Roll-forward-only is a defensible choice; shipping without saying so is not.
- **Missing work:** either add a `down` path with per-migration reverse SQL, or state the
  roll-forward-only policy explicitly in `docs/RUNBOOK.md` §11 with the concrete
  restore-from-backup procedure that replaces a rollback. Add tests for the migration runner.

---

### OPS-004 Seed

- **Requirement (exact):** The seed must run on a freshly migrated database, be idempotent, and
  produce content that is actually usable by the running application.
- **Status:** PASS
- **Implementation location:** `db/seeds/0001_dev_seed.sql`; `apps/api/scripts/migrate.mjs` `seed`
  command.
- **Runtime evidence:**

```
$ pnpm run db:seed          # RUN 1
Seeding 1 file(s)
  ✓ 0001_dev_seed.sql (63 ms)
  · seeds are not recorded in the ledger; they are written to be safe to re-run
SEED1_EXIT=0

$ pnpm run db:seed          # RUN 2 — idempotency
Seeding 1 file(s)
  ✓ 0001_dev_seed.sql (11 ms)
SEED2_EXIT=0
```

  Row counts identical after both runs (no duplication):

```
 audit_log       |     5
 hand_actions    |     4
 hands           |     1
 lesson_progress |     3
 quiz_attempts   |     4
 room_members    |     4
 rooms           |     1
 sessions        |     0
 users           |     4
```

  Usability proven through the running API rather than by row counting — the smoke run against
  this seeded database served `17 lessons`, `36 scenarios`, `90 glossary terms`, `12 legend
  profiles`, and the seeded hand `hand_devseed_0001` was readable through the hand-history route.
- **Test covering it:** NONE dedicated; content is asserted indirectly by
  `scripts/smoke-test.mjs` §4.
- **Test result:** smoke §4 — 7/7 content checks passed.
- **Reviewer notes:** Idempotency is real, not asserted. Seeds are deliberately not ledgered,
  which is the right call for fixtures.
- **Missing work:** none.

---

### OPS-005 Web application startup from the clean install

- **Requirement (exact):** The web app must start and serve pages from the clean install and
  clean build.
- **Status:** PASS
- **Implementation location:** `apps/web/package.json` (`start: next start --port 3000`);
  `apps/web/next.config.ts`.
- **Runtime evidence:** two independent paths.

  Host, from the clean build:

```
$ PRL_API_ORIGIN=http://127.0.0.1:3301 pnpm --filter @prl/web exec next start --port 3300
▲ Next.js 16.3.0
- Local:  http://localhost:3300
✓ Ready in 160ms
✓ Running next.config.ts took 149ms

/        -> 200   52679B  <title>Poker Risk Lab — a decision laboratory for poker
/learn   -> 200  101263B  <title>Learn — Poker Risk Lab
/play    -> 200   31884B  <title>Play — Poker Risk Lab
/legends -> 200  349119B  <title>AI Legends — Poker Risk Lab
/lab     -> 200  128485B  <title>Scenario Lab — Poker Risk Lab
```

  Container, through the compose proxy on my own ports:

```
$ docker ps --filter name=prl-audit-g
prl-audit-g-proxy-1   Up (healthy)   127.0.0.1:3300->8080/tcp
prl-audit-g-web-1     Up (healthy)   3000/tcp
$ curl -o /dev/null -w '%{http_code}' http://127.0.0.1:3300/
200
```

- **Test covering it:** `apps/web/test/**` (component/unit); `scripts/a11y-audit.mjs` crawls the
  rendered pages.
- **Test result:** not executed (frontend scope belongs to another reviewer).
- **Reviewer notes:** Sizes above are real server-rendered HTML, not an error shell. The
  container's own `HEALTHCHECK` (which probes `os.hostname()`, not `127.0.0.1`) reported healthy,
  which is a stronger statement than a loopback probe.
- **Missing work:** none.

---

### OPS-006 API startup from the clean install

- **Requirement (exact):** The API must start and serve from the clean install and clean build.
- **Status:** PASS
- **Implementation location:** `apps/api/src/server.ts`; `apps/api/dist/server.js` (built here).
- **Runtime evidence:**

```
$ node --env-file-if-exists=.env dist/server.js
{"level":30,…,"msg":"Server listening at http://127.0.0.1:3301"}
{"level":30,…,"routeModules":7,"msg":"listening"}
$ curl http://127.0.0.1:3301/api/v1/health
{"status":"ok","version":"0.1.0","protocolVersion":1}
```

  Container path: `prl-audit-g-api-1  Up (healthy)  127.0.0.1:3301->3001/tcp`, and through the
  proxy `GET /api/v1/health -> {"status":"ok",…}`.
- **Test covering it:** `apps/api/test/wiring.test.ts`
- **Test result:** not executed; runtime boot is the stronger evidence.
- **Reviewer notes:** none.
- **Missing work:** none.

---

### OPS-007 WebSocket startup and a real hand over the socket

- **Requirement (exact):** The WebSocket path must accept an authenticated upgrade and carry a
  hand to completion from the clean install.
- **Status:** PASS
- **Implementation location:** `apps/api/src/ws/hub.ts:188-190` (plugin registration), `:238-250`
  (route at `WS_PATH` under `API_PREFIX`, i.e. `/api/v1/ws`); `apps/api/src/ws/router.ts`.
- **Runtime evidence:** `scripts/smoke-test.mjs --strict` against my clean-install API:

```
$ PRL_API_ORIGIN=http://127.0.0.1:3301 PRL_WEB_ORIGIN=http://localhost:3300 \
    node scripts/smoke-test.mjs --strict
7. Rooms and hidden information
  ✓ the WebSocket upgrade succeeded (session cookie carried on the handshake)
  ✓ Alice took a seat over the socket
  ✓ a hand was played to completion against a bot (34 frames)
  ✓ no socket frame carried a deck, cursor or salt (34 frames scanned)
  ✓ no live frame carried another seat's hole cards mid-hand
Summary
  44 check(s) passed
Smoke test passed.       SMOKE_EXIT=0
```

  Independently reproduced with my own client (`ws-hold.mjs`), which drove `hello → sit →
  startHand` and received `welcome`, `event:handStarted` with a commitment root, `event:forcedBets`
  and a redacted `state` view.
- **Test covering it:** `apps/api/test/ws-router.test.ts` (in-process);
  `scripts/smoke-test.mjs:136-247` (real socket).
- **Test result:** smoke 44/44 passed, exit 0. Re-run a second time under the least-privilege DB
  role: 44/44 again.
- **Reviewer notes:** The upgrade path is exercised end to end including the `Origin` check and
  cookie-carrying handshake. Note that the same subsystem is the cause of OPS-010.
- **Missing work:** none for startup.

---

### OPS-008 Persistence across restart; live-schema security; least-privilege roles

- **Requirement (exact):** Data written before a process restart must survive it; the LIVE
  schema's security properties must verify (`pnpm run db:verify`); and least-privilege DB roles
  must actually exist **and actually be used by the application** — not a superuser connection
  string.
- **Status:** **PARTIAL**
- **Implementation location:** `db/migrations/0001_initial.sql:85-120` (roles created `NOLOGIN`),
  `:904-960` (privilege grants to `prl_app`); `apps/api/scripts/verify-schema.mjs:1-257`;
  `.env.example:109`; `docker-compose.yml:129-131,209`; `.github/workflows/ci.yml:246,363`.
- **Runtime evidence:**

  *Persistence.* Wrote data (guest users, a room, a completed hand and its actions) through the
  running API, killed the process, restarted it, and re-read through the API:

```
# before restart
 hands=3  hand_actions=12  rooms=5  users=19
# API killed (SIGKILL) and restarted
$ curl …/api/v1/auth/session   -> 200, same user id usr_wwgcuqyl645g3n6gobms3bvuwb
$ curl …/api/v1/rooms/<id>     -> 200, seat 0 restored, stack 1000, membership intact
$ curl …/api/v1/hands          -> 200, hand_ycefxdszk22k5jpk4kx7ilts56 with completedAt, heroNet 5
```

  *Live-schema verification.*

```
$ pnpm run db:verify
schema verification
  · 121 columns across the prl schema
  · 41 indexes
  · checked 13 tables for prl_app privileges
  ✓ every documented schema security property holds
VERIFY_EXIT=0
```

  *Roles exist and are genuinely least-privilege:*

```
   rolname    | rolsuper | rolcanlogin | rolcreatedb | rolcreaterole | rolbypassrls
 prl_migrator |    f     |      f      |      f      |       f       |      f
 prl_app      |    f     |      f      |      f      |       f       |      f
```

  I then followed `docs/RUNBOOK.md` §5 verbatim, created the `prl_api` login role, granted it
  `prl_app`, pointed the API at it and re-ran the full smoke suite:

```
$ DATABASE_URL=postgresql://prl_api:…@127.0.0.1:55432/poker_risk_lab node dist/server.js
{"level":30,…,"msg":"listening"}
$ node scripts/smoke-test.mjs --strict
  44 check(s) passed          SMOKE_LP_EXIT=0
```

  and proved the privilege boundary is real:

```
$ psql -U prl_api …
create table prl.audit_g_should_fail(x int);   ERROR: permission denied for schema prl
truncate prl.users;                            ERROR: permission denied for table users
drop table prl.hands;                          ERROR: must be owner of table hands
select * from prl.schema_migrations limit 1;   ERROR: permission denied for table schema_migrations
delete from prl.hands;                         ERROR: permission denied for table hands
```

  *But nothing ships configured that way.* Every shipped connection string is the superuser:

```
.env.example:109        DATABASE_URL=postgresql://poker:poker-dev-only@127.0.0.1:5432/poker_risk_lab
docker-compose.yml:209  DATABASE_URL: postgres://${POSTGRES_USER:-poker}:…@postgres:5432/…
.github/workflows/ci.yml:246  DATABASE_URL: postgres://postgres:postgres@…/poker_risk_lab_test
.github/workflows/ci.yml:363  DATABASE_URL: postgres://postgres:postgres@…/poker_risk_lab_e2e
```

  and `poker` is `rolsuper = t`.
- **Test covering it:** `apps/api/scripts/verify-schema.mjs` check 6 (asserts `prl_app` lacks
  CREATE/DROP/TRUNCATE); no test anywhere connects as a `prl_app` member.
- **Test result:** `db:verify` exit 0 against the live schema. The least-privilege *connection*
  is untested by CI — I am the first to have exercised it, per the grep above.
- **Reviewer notes:** Persistence and `db:verify` are unambiguous PASSes. The roles are real,
  correctly scoped, and — to the team's credit — the runbook's documented least-privilege path
  actually works when followed, which is more than most projects manage. The gap is that it is
  followed nowhere: dev, compose and both CI database jobs run as a superuser, and
  `docs/RUNBOOK.md:216-219` admits it ("the least-privilege path is not exercised in
  development … a missing `GRANT` will not surface locally"). A privilege model that no automated
  run exercises is one merge away from silently breaking, and the failure would first appear in
  production.
- **Missing work:** make one CI job (the `test` or `end-to-end` job) connect as a `prl_app`
  member, so a missing `GRANT` fails a build rather than a deployment.

---

### OPS-009 Health and readiness endpoints under dependency failure

- **Requirement (exact):** Health/readiness endpoints must exist and must tell the truth. Forcing
  a dependency failure (stopping the database) must flip readiness to unhealthy. A health check
  that always returns 200 is a finding.
- **Status:** PASS
- **Implementation location:** `apps/api/src/app.ts:198` (`/api/v1/health`, liveness, rate-limit
  exempt), `:200-211` (`/api/v1/ready`, queries the DB, 503 while degraded);
  `apps/api/src/db.ts:63` (`ping` returns a result rather than throwing).
- **Runtime evidence:**

```
=== BASELINE (DB up) ===
health:  200  {"status":"ok","version":"0.1.0","protocolVersion":1}
ready:   200  {"status":"ready","checks":{"database":{"ok":true}}}

=== docker stop prl-audit-g-postgres-1 ===
-- attempt 1 --  health: 200 {"status":"ok",…}
                 ready:  503 {"status":"degraded","checks":{"database":{"ok":false,
                              "detail":"database did not answer"}}}
-- attempt 2 --  health: 200        ready: 503 degraded
-- attempt 3 --  health: 200        ready: 503 degraded

=== /ready latency while degraded (must not hang) ===
attempt 503 in 0.011063s
attempt 503 in 0.003575s
attempt 503 in 0.003104s

=== docker start prl-audit-g-postgres-1; NO api restart ===
{"status":"ready","checks":{"database":{"ok":true}}} <- 200   (x5)
```

- **Test covering it:** `apps/api/test/database-availability.test.ts`,
  `apps/api/test/wiring.test.ts`
- **Test result:** not executed; the live dependency-failure test above is stronger.
- **Reviewer notes:** This is done properly and is the correct split: liveness stays 200 (the
  process is alive — restarting it would not fix a dead database), readiness flips to 503 with a
  non-leaking detail string, the degraded response is fast rather than hanging on a connect
  timeout, and the service self-heals when the dependency returns without needing a restart. Both
  container `HEALTHCHECK`s probe `os.hostname()` rather than `127.0.0.1`, so a process bound to
  loopback reports unhealthy instead of healthy-and-unreachable — verified present in both image
  configs.
- **Missing work:** none.

---

### OPS-010 Graceful shutdown on SIGTERM

- **Requirement (exact):** On SIGTERM the process must drain connections, close the database
  pool, and exit 0 within a sane time — not hang, drop in-flight work, or exit non-zero.
- **Status:** **FAIL**
- **Implementation location:**
  * `apps/api/src/server.ts:91-129` (`shutdown`), `:76-89` (`drainIdleConnections`), `:98-102`
    (grace deadline → `process.exit(EXIT_SHUTDOWN_FAILED)`).
  * **Root cause:** `apps/api/src/ws/hub.ts:188-190` registers `@fastify/websocket` with
    `options: { maxPayload: …, clientTracking: false }`.
- **Runtime evidence:** four controlled runs, identical build, only the connection state differs.

```
--- (1) idle server, no WebSocket -------------------------------------------------
IDLE SHUTDOWN: 0.145s     IDLE EXIT CODE: 0
{"reason":"SIGTERM","msg":"shutting down"}     ← and nothing else; clean

--- (2) ONE open WebSocket, no hand in flight --------------------------------------
WS-NO-HAND SHUTDOWN: 10.158s     EXIT CODE: 1
{"level":30,"reason":"SIGTERM","msg":"shutting down"}
{"level":50,"reason":"SIGTERM","graceMs":10000,"msg":"shutdown timed out; exiting hard"}
client: WS CLOSE code=1006 reason="" frames=2        ← abnormal, no close frame

--- (3) ONE open WebSocket WITH a hand in flight -----------------------------------
SHUTDOWN TOOK 10.179s     EXIT CODE: 1
{"level":50,"reason":"SIGTERM","graceMs":10000,"msg":"shutdown timed out; exiting hard"}
client: WS CLOSE code=1006 reason="" frames=10

--- (4) THE DEPLOYMENT PATH: docker compose stop api, one open WebSocket ------------
CONTAINER STOP TOOK 10.62s
State.Status=exited  ExitCode=137  OOMKilled=false      ← 137 = 128+9 = SIGKILL
container log: {"level":50,"reason":"SIGTERM","graceMs":10000,"msg":"shutdown timed out; exiting hard"}
client: WS CLOSE code=1006 reason="" frames=10

--- control: docker compose stop api, NO WebSocket ---------------------------------
NO-WS CONTAINER STOP: 0.63s     ExitCode=0
{"reason":"SIGTERM","msg":"shutting down"}
{"reason":"SIGTERM","msg":"shutdown complete"}          ← the log line that never appears in (2)-(4)
```

  **Mechanism, proven from the installed sources rather than inferred.** `ws`'s
  `WebSocketServer` only creates the client set when tracking is on —
  `node_modules/.../ws/lib/websocket-server.js:135`:

```js
    if (options.clientTracking) {
      this.clients = new Set();
```

  and `@fastify/websocket`'s `defaultPreClose`
  (`node_modules/.../@fastify/websocket/index.js:215-228`) closes sockets only through that set:

```js
  function defaultPreClose (done) {
    const server = this.websocketServer
    if (server.clients) {              // <-- undefined when clientTracking: false
      for (const client of server.clients) { client.close() }
    }
    fastify.server.removeListener('upgrade', onUpgrade)
    server.close(done)
    done()
  }
```

  With `clientTracking: false` set at `hub.ts:189`, that loop never runs. The upgraded sockets stay
  open; an upgraded socket is never "idle" to Node, so `closeIdleConnections()` — the whole
  mechanism of `drainIdleConnections` at `server.ts:76-89` — cannot touch it; `server.close()`
  waits for it forever; `app.close()` never resolves; the hub's own cleanup at `hub.ts:228-235`
  (`router.closeAll('server shutting down')`) is an **`onClose`** hook and therefore never runs;
  and the deadline at `server.ts:98-102` fires `process.exit(1)`.

  In a container the app never even reaches its own exit 1: Docker's default 10 s stop timeout and
  `SHUTDOWN_GRACE_MS`'s default 10 000 ms are **the same number**, and `docker-compose.yml` sets
  neither `stop_grace_period` nor `SHUTDOWN_GRACE_MS` (verified: neither string appears in the
  file). So SIGKILL wins the race and the container exits 137.
- **Test covering it:** `apps/api/test/shutdown.test.ts` — and this is the point:

```
$ grep -n "WebSocket\|ws://\|upgrade\|/ws" apps/api/test/shutdown.test.ts
  >>> NO WebSocket anywhere in shutdown.test.ts <<<
```

  It opens raw TCP sockets and speaks HTTP/1.1 with `connection: keep-alive`
  (`shutdown.test.ts:31,255,273`). Nothing in it upgrades.
- **Test result:**

```
$ node --test 'apps/api/test/shutdown.test.ts'
▶ SIGTERM with a request in flight on a keep-alive socket
  ✔ answers the request, exits 0, and does not wait out the grace (1060ms)
  ✔ exits 0 with a worker-thread calculation still running, and leaves no thread behind (3488ms)
  ✔ exits 0 with nothing in flight at all (209ms)
ℹ tests 3   ℹ pass 3   ℹ fail 0
```

  Three green tests that assert exactly the case that works, and none that touches the case the
  product is built around.
- **Reviewer notes:** This is the single most serious finding in my scope, and it invalidates a
  claim the runbook makes emphatically. `docs/RUNBOOK.md:394-397` states: *"Graceful shutdown on
  SIGTERM/SIGINT: stop accepting, drain in-flight work, close the database pool and the equity
  worker pool, **exit 0**. It exits non-zero only if the drain genuinely fails or the grace period
  expires first,"* and `:409-411` adds *"Do not add retries or a longer grace to compensate for an
  exit 1 under load: **that behaviour was a defect and is fixed**."* The defect is not fixed. It
  was fixed for HTTP keep-alive and left in place for WebSockets, which is the one connection type
  every user of the live table holds. It does not need load: **one idle socket is enough**.

  Operational consequence: every deploy or restart while any learner has a table open takes the
  full grace period, is SIGKILLed, drops every socket with 1006 instead of a close frame, and
  reports a failed stop (137) to the orchestrator — which under `restart: unless-stopped` reads as
  a crash, not a clean stop. The in-flight hand is abandoned (see OPS-014).
- **Missing work:**
  1. Pass an explicit `preClose` to the plugin at `hub.ts:188-190` that closes the hub's own
     tracked connections (the hub already keeps a `live` map), or drop `clientTracking: false` so
     the plugin's default `preClose` can do its job.
  2. Move `router.closeAll(…)` from the `onClose` hook (`hub.ts:228`) to a `preClose` hook, since
     `onClose` runs after `server.close()` resolves and therefore cannot help unblock it.
  3. Extend `apps/api/test/shutdown.test.ts` with a case that holds an open WebSocket. It must
     fail before the fix.
  4. Set `stop_grace_period` in `docker-compose.yml` strictly above `SHUTDOWN_GRACE_MS`, which is
     what `docs/RUNBOOK.md:408` tells operators to do and the repo's own compose file does not.

---

### OPS-011 Production build for both apps, from clean

- **Requirement (exact):** `pnpm run build` must succeed for both apps from a clean install.
  Determine whether `packages/ui` having no `dist/` is a build gap.
- **Status:** PASS — and the missing `packages/ui/dist` is **not** a gap.
- **Implementation location:** `package.json:16` (`build`); `packages/ui/package.json`
  (`exports: { ".": "./src/index.ts" }`, `build: tsc -p tsconfig.json --noEmit`);
  `apps/web/next.config.ts` (`transpilePackages: ['@prl/ui', …]`).
- **Runtime evidence:** from the clean install, with no pre-existing `dist/` anywhere:

```
$ time pnpm run build
Scope: 6 of 9 workspace projects
packages/poker-engine build: Done      packages/contracts build: Done
packages/poker-math   build: Done      packages/content   build: Done
packages/poker-ai     build: Done      packages/ui        build: Done
Scope: 2 of 9 workspace projects
apps/api build: Done
apps/web build: ▲ Next.js 16.3.0 (Turbopack)
apps/web build: ✓ Compiled successfully in 3.1s
apps/web build:   Finished TypeScript in 428ms
apps/web build: ✓ Generating static pages using 9 workers (11/11) in 337ms
apps/web build: Route (app)  ┌ ○ /  ├ ○ /_not-found  ├ ƒ /lab  ├ ƒ /lab/[scenarioId]
                             ├ ƒ /learn  ├ ƒ /learn/[lessonId]  ├ ƒ /learn/glossary
                             ├ ƒ /legends  ├ ƒ /legends/[profileId]  ├ ƒ /legends/compare
                             ├ ƒ /legends/hand-review  ├ ƒ /play  ├ ƒ /review  └ ƒ /review/[handId]
apps/web build: Done
real	0m13.869s      BUILD_EXIT=0
```

  `packages/ui` after the build: `dist present? NO`. That is by construction — its `exports` map
  points at `./src/index.ts`, its `build` script is `tsc --noEmit` (a typecheck that emits
  nothing), and `next.config.ts` lists it in `transpilePackages` so Next compiles the source. The
  built output does contain the UI: `apps/web/.next/server/app/index.html` carries the `prl-`
  class namespace, and the five routes render (OPS-005).
- **Test covering it:** `.github/workflows/ci.yml:477-513` (`build` job runs `pnpm run build`).
- **Test result:** not executed in CI here; executed locally, exit 0.
- **Reviewer notes:** No gap, but a wart worth one line of comment somewhere: a script named
  `build` that emits nothing is exactly the kind of thing that gets "fixed" by someone adding
  `--noEmit false` and breaking the `exports` map. The consequence to be aware of is that
  `@prl/ui` is only consumable by a bundler that transpiles TypeScript — it cannot be `import`ed
  by plain Node, and correctly is not (the API image does not contain it).
- **Missing work:** none. Optionally rename `packages/ui`'s `build` to make its no-emit nature
  obvious.

---

### OPS-012 OCI images actually build

- **Requirement (exact):** `Dockerfile.api` and `Dockerfile.web` must actually build.
- **Status:** PASS
- **Implementation location:** `Dockerfile.api`, `Dockerfile.web`
- **Runtime evidence:**

```
$ docker build -f Dockerfile.api -t prl-audit-g/api:test .
#10 [prod-deps] pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@prl/api..."
#10 19.77 Done in 17s using pnpm v11.10.0
#13 [build 2/3] pnpm --filter "@prl/api..." run build     … apps/api build: Done   #13 DONE 1.7s
#17 naming to docker.io/prl-audit-g/api:test done
real	0m27.354s      API_BUILD_EXIT=0

$ docker build -f Dockerfile.web -t prl-audit-g/web:test .
#18 naming to docker.io/prl-audit-g/web:test done
real	1m5.680s       WEB_BUILD_EXIT=0

$ docker images | grep prl-audit-g
prl-audit-g/api:test   a4ab0dc61205   372MB   (83.1MB compressed)
prl-audit-g/web:test   666784e276c6   790MB   (170MB compressed)
```

  Both images were then run and served traffic end to end (OPS-005/006/013).
- **Test covering it:** NONE.

```
$ grep -n "docker build\|Dockerfile" .github/workflows/*.yml
.github/workflows/ci.yml:99   # (comment only)
.github/workflows/ci.yml:226  # (comment only)
```

- **Test result:** not executed — **CI never builds either image**.
- **Reviewer notes:** Both build cleanly today. But nothing in CI would notice if they stopped:
  the only mentions of "Dockerfile" in the workflows are comments. Given that both Dockerfiles
  contain non-trivial multi-stage logic whose failure modes the file headers themselves describe
  as previously-shipped bugs (`ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`, `ERR_MODULE_NOT_FOUND` on a
  `@prl/*` dist), an unbuilt-in-CI image is a real gap.
- **Missing work:** add a CI job that builds both images (and ideally runs the API image's own
  `HEALTHCHECK` against a service container).

---

### OPS-013 Container security

- **Requirement (exact):** The images must run as non-root (verified from inside the running
  container, not by reading the `USER` line), bake no secrets into layers, use a minimal base,
  carry a healthcheck, and honour the read-only rootfs / dropped capabilities the repo claims.
- **Status:** PASS
- **Implementation location:** `Dockerfile.api:~228` (`USER node`), `:~236` (`HEALTHCHECK`);
  `Dockerfile.web` (equivalent); `docker-compose.yml:233-243,281-291,445-451`
  (`read_only`, `tmpfs`, `security_opt: no-new-privileges`, `cap_drop: ALL`); `.dockerignore`.
- **Runtime evidence:** measured from **inside the running containers**.

```
=== actual uid/gid ===
api    uid=1000(node)  gid=1000(node)   whoami=node
web    uid=1000(node)  gid=1000(node)   whoami=node
proxy  uid=101(nginx)  gid=101(nginx)   whoami=nginx

=== effective capability sets of the container's own process ===
api / web / proxy, all three identical:
CapInh: 0000000000000000   CapPrm: 0000000000000000   CapEff: 0000000000000000
CapBnd: 0000000000000000   CapAmb: 0000000000000000   NoNewPrivs: 1

=== read-only rootfs, tested by trying to write ===
api:   touch: cannot touch '/app/AUDIT_G_WRITE_TEST': Read-only file system   -> read-only
web:   touch: cannot touch '/app/AUDIT_G_WRITE_TEST': Read-only file system   -> read-only
proxy: touch: /etc/nginx/AUDIT_G: Read-only file system                        -> read-only

=== docker inspect ===
api   ReadonlyRootfs=true CapDrop=[ALL] CapAdd=[] SecurityOpt=[no-new-privileges:true] Privileged=false User=node
web   ReadonlyRootfs=true CapDrop=[ALL] CapAdd=[] SecurityOpt=[no-new-privileges:true] Privileged=false User=node
proxy ReadonlyRootfs=true CapDrop=[ALL] CapAdd=[] SecurityOpt=[no-new-privileges:true] Privileged=false User=101

=== secrets in the image filesystem ===
$ find / -xdev \( -name ".env" -o -name ".env.*" -o -name "*.pem" -o -name "id_rsa*" -o -name ".git" \)
---done---            (no matches)

=== env baked into the image config ===
api: ["PATH=…","NODE_VERSION=24.18.0","YARN_VERSION=1.22.22","NODE_ENV=production","PORT=3001","HOST=0.0.0.0"]
web: ["PATH=…","NODE_VERSION=24.18.0","YARN_VERSION=1.22.22","NODE_ENV=production","PORT=3000","HOSTNAME=0.0.0.0"]

=== HEALTHCHECK present in both image configs ===
api: {"Test":["CMD","node","-e","fetch(`http://${require('node:os').hostname()}:${process.env.PORT ?? 3001}/api/v1/health`)…"],
      "Interval":30s,"Timeout":5s,"StartPeriod":30s,"Retries":3}
web: {"Test":["CMD","node","-e","fetch(`http://${require('node:os').hostname()}:${process.env.PORT ?? 3000}/`)…"], …}

=== dev tooling / migration rights excluded from the runtime image ===
$ ls /app/node_modules/.pnpm | grep -E "^(typescript|@types|@biomejs|axe-core)"   -> (none)
$ ls /app/node_modules/.pnpm | wc -l                                              -> 73
$ ls /app/apps/api/      -> dist  node_modules  package.json  tsconfig.test.json
$ ls /app/db             -> No such file or directory
```

- **Test covering it:** NONE (no CI image build, therefore no image assertions).
- **Test result:** not executed.
- **Reviewer notes:** This is the best-executed area of the release and the claims hold up under
  measurement rather than inspection: the capability set is genuinely empty in all five vectors,
  the read-only rootfs was proven by an actual failed write, and the non-root uid came from `id`
  inside the container. `.dockerignore` excluding `.env`/`.env.*` demonstrably worked — no
  environment file reached any layer. `apps/api/scripts/` and `db/` are genuinely absent, so the
  serving image cannot migrate, as documented.

  Two small notes, neither blocking:
  1. `Dockerfile.api`'s header claims *"the runtime stage descends from this, so pnpm and corepack
     shims never reach the shipped image."* Half true: `pnpm`, `curl` and `wget` are absent, but
     `/usr/local/bin/npm` and `/usr/local/bin/corepack` **are** present — they come from the
     `node:24.18.0-bookworm-slim` base, not from the toolchain stage. A package manager in a
     runtime image is a foothold; the sentence should either say so or the shims should be removed.
  2. "Minimal base" is `bookworm-slim`, not distroless or alpine — a reasonable trade, but 790 MB
     for the web image is large. `tsconfig.test.json` also survives the prune in the API image
     (harmless, but the deny-list prune missed it).
- **Missing work:** none blocking. Optionally remove the `npm`/`corepack` shims in the runtime
  stage and correct the Dockerfile comment.

---

### OPS-014 Restart / recovery mid-hand

- **Requirement (exact):** Kill the API mid-hand and restart. Given the documented
  one-API-process rule and in-memory room state, establish what is actually lost, whether it is
  handled gracefully, and whether it corrupts persisted data.
- **Status:** **PARTIAL**
- **Implementation location:** `apps/api/src/rooms/registry.ts` (in-memory authoritative state);
  `apps/api/src/repositories/hands.ts:261,397,443` (`where … completed_at is null`);
  `db/migrations/0001_initial.sql` (`hands_room_hand_number_key UNIQUE (room_id, hand_number)`,
  `hands_live_by_room_idx … WHERE completed_at IS NULL`).
- **Runtime evidence:** started a hand, held the socket without acting, `kill -9` the API mid-hand,
  restarted, reconnected as the same user to the same room.

```
# before the kill — hand in flight, blinds posted
STATE handId=hand_yfvrhrcribrjrlqjj5audqwxzp street=preflop toAct=0 seq=0
      seats=[{"i":0,"stack":995},{"i":1,"stack":990}]
DB:   hand_yfvrhrcribrjrlqjj5audqwxzp | room_m67… | preflop | hand_number 1 | completed_at NULL

$ kill -9 <api pid>     -> client: WS CLOSE code=1006 frames=10

# after restart, same session, same room
RESUME session:   200  usr_wwgcuqyl645g3n6gobms3bvuwb        ← session survived
RESUME room read: 200  seat 0, stack 1000, membership intact ← room survived
WELCOME seats=[{seat 0, stack 1000, AuditG},{seat 1, stack 1000, bot}]
STATE view=null                                              ← the hand is simply gone

# can the room continue?  YES — numbering resumed correctly, no constraint violation
event handStarted hand_ycefxdszk22k5jpk4kx7ilts56
DB: hand_yfvrhrcribrjrlqjj5audqwxzp | 1 | preflop | done=f
    hand_ycefxdszk22k5jpk4kx7ilts56 | 2 | preflop | done=f→t
api log after restart: (no error/warn lines at all)
```

  What is left behind, permanently:

```
$ select count(*) from prl.hands where completed_at is null;
 orphaned_live_hands
 --------------------
                   3          ← one per restart-during-a-hand, in this short session alone

$ curl …/api/v1/hands            # the LEARNER's own history
{"hands":[{"id":"hand_ycefxdszk22k…","handNumber":2,"completedAt":"…","heroNet":5,"potTotal":15},
          {"id":"hand_yfvrhrcrib…","handNumber":1,"completedAt":null,"heroNet":null,
           "endedByFold":false,"potTotal":0}]}          ← a ghost row with null fields

$ curl …/api/v1/hands/hand_yfvrhrcribrjrlqjj5audqwxzp   -> 200
  "reveal": null,
  "verification": {"ok": false, "reason":"this hand has not published a reveal yet, …"},
  "seats":[{"seat":0,…,"holeCards":["Qc","9s"],"showedDown":false},
           {"seat":1,…,"holeCards":null,"showedDown":false}]     ← opponent still redacted
```

  Searched for any reconciliation on boot — there is none:
  `grep -rniE "abandon|orphan|reconcil|stale" apps/api/src` returns only worker-pool and
  action-sequence matches, nothing that sweeps `completed_at IS NULL` at startup.
- **Test covering it:** NONE for restart/recovery. `apps/api/test/table-concurrency.test.ts` and
  `seat-reuse-identity.test.ts` cover adjacent ground but not process death.
- **Test result:** not executed — no such test exists.
- **Reviewer notes:** The good news is genuine and worth stating: **nothing is corrupted.** The
  unique `(room_id, hand_number)` constraint is not violated because the registry rehydrates the
  next hand number from the database (hand 1 orphaned → next hand is 2, not a duplicate 1);
  chip stacks are restored from `room_members` so the posted blinds are effectively refunded
  rather than lost; sessions, rooms, memberships and completed hand history all survive; and the
  confidentiality property still holds on the abandoned hand (the opponent's `holeCards` are
  `null`). The documented one-process rule and `deploy: replicas: 1` are consistent with what I
  observed.

  What is not handled gracefully is the residue. Each restart during a hand leaves a permanent
  `completed_at IS NULL` row that nothing will ever finish. It is not merely internal: it appears
  in the learner's own hand-history list with `completedAt: null`, `heroNet: null`,
  `potTotal: 0`, and its detail page renders as a hand that can never be verified. Nothing logs
  it, nothing sweeps it, and it accumulates one row per interrupted hand for the life of the
  database. Combined with OPS-010 — where *every* deploy with a live table is a hard kill — this
  is not a rare path.

  One inconsistency worth a second look by whoever owns the bot layer: the same bot user
  (`usr_chnskoziqemmhvr4x5ov7tf2tj`) was presented as profile `patient-technician` before the
  crash and `tight-aggressive` after rehydration, in a room created with
  `bots: [{ profile: 'tight-aggressive' }]`. The persisted value looks right and the in-memory one
  looks wrong.
- **Missing work:** on startup (or on room rehydration), mark hands that are `completed_at IS NULL`
  for a room with no live in-memory state as abandoned — an explicit terminal state, excluded from
  the learner's history or shown as "interrupted" — and log it. Add a test that kills the process
  mid-hand and asserts the resulting row state.

---

### OPS-015 Deployment documentation — `docs/RUNBOOK.md` followed literally

- **Requirement (exact):** Follow `docs/RUNBOOK.md` literally as a new operator. Every command
  must work as written. Report every command that fails, is missing, or is wrong. Also verify
  whether `docs/reviews/final-release-report.md`, referenced by `docs/REPORT.md`, actually exists.
- **Status:** **FAIL**
- **Implementation location:** `docs/RUNBOOK.md` (531 lines, §1-§11); `docs/REPORT.md:236`.
- **Runtime evidence:**

  **Commands that work as written** (all executed from the clean tree):
  `corepack enable`, `node --version` (v24.18.0), `pnpm --version` (11.10.0),
  `pnpm install --frozen-lockfile`, `pnpm run security:audit` (8/8 gates, exit 0),
  `cp .env.example .env`, the secret-generation one-liner, `pnpm run db:wait`
  (`ready PostgreSQL 16.15 after 1 attempt(s)`), `pnpm run db:migrate`, `pnpm run db:seed`,
  `pnpm run db:migrate:status`, `pnpm run db:verify`, `pnpm run build:packages`,
  `pnpm run build`, `pnpm run test:smoke -- --strict`, `docker compose up -d --build`,
  `docker compose up -d proxy`, and the whole of §5's login-role SQL:

```
$ psql -v api_password=… -v deployer_password=… -f <§5 verbatim>
CREATE ROLE / CREATE ROLE / GRANT ROLE / GRANT ROLE
   rolname    | rolcanlogin
 prl_migrator |      f
 prl_app      |      f
 prl_api      |      t
 prl_deployer |      t
```

  **Failure 1 — §11.4 Backups. The documented disaster-recovery procedure produces a database
  that fails the repo's own verification.** Run exactly as written:

```
$ pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > prl-2026-08-18.dump
dump exit=0 size=71200 bytes
$ pg_restore --dbname="$TARGET_URL" --no-owner prl-2026-08-18.dump
restore exit=0
$ pnpm run db:verify                       # the runbook's own next line
schema verification
  · 121 columns across the prl schema
  · 41 indexes
  · checked 13 tables for prl_app privileges
  ✗ prl_app: lacks USAGE on schema prl, so the app cannot read anything
  1 schema property/properties violated
VERIFY_RESTORED_EXIT=1
```

  And the restored database genuinely cannot serve traffic under the role §5 mandates:

```
$ psql -U prl_api -d prl_restore_test -c "select count(*) from prl.users;"
ERROR:  permission denied for schema prl
```

  Control, proving the flags are the cause — the same dump/restore **without**
  `--no-owner --no-privileges`:

```
$ pg_dump --format=custom "$DATABASE_URL" > full.dump && pg_restore --dbname=… full.dump
$ node apps/api/scripts/verify-schema.mjs
  ✓ every documented schema security property holds        VERIFY_FULLDUMP_EXIT=0
```

  Schema ownership after each path:

```
poker_risk_lab   : prl owner=prl_migrator     (original)
prl_restore_test : prl owner=poker            (runbook's flags — ownership and grants stripped)
prl_restore_test2: prl owner=prl_migrator     (without the flags — correct)
```

  As a second-order effect, `db:reset` also fails on the runbook-restored database
  (`✗ must be owner of schema prl`). The runbook documents no re-grant step, so an operator
  rehearsing a restore — which §11.4 explicitly tells them to do — is left with a database that
  the very next documented command declares broken and no instruction for fixing it.

  **Failure 2 — §10 states a graceful-shutdown behaviour that does not exist.**
  `docs/RUNBOOK.md:394-397`: *"Graceful shutdown on SIGTERM/SIGINT: … exit 0. It exits non-zero
  only if the drain genuinely fails or the grace period expires first,"* and `:409-411`: *"Do not
  add retries or a longer grace to compensate for an exit 1 under load: that behaviour was a
  defect and is fixed."* Disproven in OPS-010 with one idle WebSocket and no load: 10.16 s, exit 1
  on the host and exit 137 in the container. §11.6's *"Shutdown is graceful on SIGTERM (drain,
  close the pool)"* is wrong for the same reason.

  **Failure 3 — §10 gives an instruction the repository's own compose file violates.** *"Set the
  orchestrator's termination grace period above `SHUTDOWN_GRACE_MS`, not below it."*
  `docker-compose.yml` sets neither `stop_grace_period` nor `SHUTDOWN_GRACE_MS`, so both are 10 s
  and the container is SIGKILLed rather than allowed to reach its own handler. Verified: neither
  string appears anywhere in the file.

  **Failure 4 — a referenced file does not exist.**

```
$ grep -n "final-release-report" docs/REPORT.md
236:preserved rather than averaged) and `reviews/final-release-report.md` (the release decision).
$ ls -la docs/reviews/final-release-report.md
ls: docs/reviews/final-release-report.md: No such file or directory
$ ls docs/reviews/
agent-a-architecture.md  agent-b-poker-math.md  agent-c-security.md  agent-d-frontend.md
agent-e-testing.md       agent-f-ai-education.md  agent-g-production.md  release-findings.md
```

  `docs/REPORT.md:236` points at *"the release decision"* — the one document a reader would go to
  in order to sanity-check whether this thing should ship. It is not there.

  **Not a defect, for the record:** §2's `pnpm run db:setup` and §6's `docker compose up -d
  postgres` target the default compose project, which I was required not to touch; I executed
  their constituent parts (`db:up` equivalent, `db:wait`, `db:migrate`, `db:seed`) against my own
  project instead, and all four worked. §7's variable table matches `.env.example`. §9's
  troubleshooting entries I could reach (`4406`, `stale_action_sequence`, the build-time-only
  refusal) are accurate.
- **Test covering it:** NONE. No test executes runbook commands; nothing checks that referenced
  documents exist.
- **Test result:** not executed.
- **Reviewer notes:** The runbook is unusually detailed and mostly correct — the §5 least-privilege
  path in particular is real and works, which is rare. That makes the two substantive failures
  worse rather than better: an operator has every reason to trust this document, and the two
  places it is wrong are the disaster-recovery procedure and the shutdown behaviour, i.e. exactly
  the two things you rely on it for at 3am. A restore that silently produces an unservable
  database is the more dangerous of the two, because the operator following §11.4 will believe
  their backups are rehearsed.
- **Missing work:**
  1. §11.4: drop `--no-owner --no-privileges`, or add the explicit re-grant step after restore
     (and state that `db:verify` failing on `prl_app: lacks USAGE` is the symptom of having used
     those flags).
  2. §10 / §11.6: correct the graceful-shutdown claim, or fix OPS-010 and keep it.
  3. Set `stop_grace_period` in `docker-compose.yml` so the repo obeys its own §10 instruction.
  4. Create `docs/reviews/final-release-report.md` or remove the reference at `docs/REPORT.md:236`.

---

## Severity-classified issues

### P0 — security / correctness / release catastrophe

* **P0-1 — Graceful shutdown is broken for every WebSocket connection; the fix that was claimed
  covers only HTTP.** `apps/api/src/ws/hub.ts:189` sets `clientTracking: false`, which makes
  `@fastify/websocket`'s `defaultPreClose` a no-op (`if (server.clients)` is `undefined`), so
  `server.close()` never resolves, `app.close()` never returns, the hub's `onClose` cleanup
  (`hub.ts:228`) never runs, and the grace deadline (`server.ts:98-102`) exits 1. One idle socket
  is sufficient; no load is needed. Measured: idle server 0.145 s / exit 0; with one WebSocket
  10.18 s / exit 1; `docker compose stop api` with one WebSocket 10.62 s / **exit 137 (SIGKILL)**
  with the client dropped on close code 1006. `docs/RUNBOOK.md:394-397,409-411` states the exact
  opposite and calls the behaviour "fixed". `apps/api/test/shutdown.test.ts` passes 3/3 and
  contains no WebSocket. Every deploy while any learner has a table open is a hard kill.
  (OPS-010, OPS-015)

* **P0-2 — The documented backup/restore procedure yields a database the application cannot
  serve.** `docs/RUNBOOK.md` §11.4's `pg_dump --no-owner --no-privileges` + `pg_restore
  --no-owner` strips every grant; the restored database fails the runbook's own next command
  (`pnpm run db:verify` → `✗ prl_app: lacks USAGE on schema prl`, exit 1) and
  `select … from prl.users` as `prl_api` returns `permission denied for schema prl`. No re-grant
  step is documented. A "rehearsed" restore per this runbook produces an unservable database.
  (OPS-015)

### P1 — required feature broken or missing

* **P1-1 — No rollback path for migrations, and no stated policy in its place.** `migrate.mjs`
  offers only `up | status | seed | reset`; `reset` is a schema drop and is refused under
  `NODE_ENV=production`; there are no `*.down.sql` files. There is therefore no way to undo a bad
  migration in production, and `docs/RUNBOOK.md` §11 contains no rollback procedure. (OPS-003)

* **P1-2 — The least-privilege database role is exercised by nothing that runs automatically.**
  `prl_app`/`prl_migrator` exist, are correctly scoped, and — I verified — actually work
  (44/44 smoke checks as a `prl_api` member; `CREATE`/`TRUNCATE`/`DROP`/`DELETE` all denied). But
  `.env.example:109`, `docker-compose.yml:209` and both CI database jobs
  (`ci.yml:246,363`) connect as a **superuser**. A missing `GRANT` in a future migration would
  first surface in production. `docs/RUNBOOK.md:216-219` admits this. (OPS-008)

### P2 — significant quality gap

* **P2-1 — Interrupted hands leave permanent orphan rows that surface to the learner.** Killing
  the API mid-hand leaves `prl.hands` rows with `completed_at IS NULL` forever; there is no
  startup reconciliation (`grep` for abandon/orphan/reconcile finds nothing). They appear in
  `GET /api/v1/hands` with `completedAt: null, heroNet: null, potTotal: 0`. Nothing is corrupted —
  hand numbering resumes correctly, stacks are restored, redaction still holds — but 3 accumulated
  in one short audit session, and P0-1 makes this the normal deploy path. (OPS-014)

* **P2-2 — CI never builds either Docker image.** `grep "docker build" .github/workflows/*.yml`
  finds only comments. Both Dockerfiles contain multi-stage logic whose past failures their own
  headers document; nothing would catch a regression before a deploy. (OPS-012)

* **P2-3 — No test covers the migration runner or restart/recovery.** `apps/api/scripts/migrate.mjs`
  (693 lines, advisory locking, checksum drift, out-of-order refusal) has no test file, and
  `pnpm run test:scripts` globs `scripts/**` only. No test kills the process mid-hand.
  (OPS-003, OPS-014)

* **P2-4 — `docker-compose.yml` violates the runbook's own grace-period instruction.** Neither
  `stop_grace_period` nor `SHUTDOWN_GRACE_MS` is set, so Docker's 10 s stop timeout exactly equals
  the app's 10 s drain deadline and SIGKILL wins — turning P0-1's exit 1 into exit 137.
  (OPS-010, OPS-015)

* **P2-5 — `docs/REPORT.md:236` references `docs/reviews/final-release-report.md`, which does not
  exist.** The referenced document is described as "the release decision". (OPS-015)

### P3 — polish

* **P3-1 — The published example `SESSION_COOKIE_SECRET` is accepted silently outside production.**
  `config.ts:375-383` length-checks but does not run the placeholder check outside production, so
  a non-production deployment signs cookies with a value from a public repository and logs nothing.
  (OPS-002)
* **P3-2 — `POSTGRES_USER/PASSWORD/DB/PORT` are interpolated by `docker-compose.yml` but are not
  declared keys in `.env.example`** — only mentioned in a prose comment at `.env.example:103-107`.
  (OPS-002)
* **P3-3 — `Dockerfile.api`'s header claims corepack never reaches the shipped image; it does.**
  `/usr/local/bin/npm` and `/usr/local/bin/corepack` are present in the runtime image (from the
  base). `pnpm`, `curl`, `wget` are correctly absent. (OPS-013)
* **P3-4 — The `web` container exits 143 rather than 0 on stop** (`next start` installs no SIGTERM
  handler), while `api` (no socket) and `proxy` both exit 0. (OPS-010)
* **P3-5 — A 404 on any unknown path returns `content_not_found` / "That lesson, quiz or scenario
  does not exist."** — misleading for arbitrary paths such as `/healthz`. (OPS-009)
* **P3-6 — `packages/ui`'s `build` script is `tsc --noEmit`,** i.e. a typecheck named "build". Not
  a defect (its `exports` map points at source and Next transpiles it), but an invitation to a
  well-meaning breaking "fix". (OPS-011)
* **P3-7 — Bot profile label differs across a restart** for the same bot user
  (`patient-technician` in memory vs `tight-aggressive` persisted, in a room created with
  `tight-aggressive`). Cosmetic, but the in-memory value looks wrong. (OPS-014)
