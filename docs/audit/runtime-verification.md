# Runtime Verification Record

**Audit date:** 2026-08-18
**Executed by:** lead auditor (own commands, own isolated database and ports) and Reviewer G
(clean-environment production audit in an isolated compose project).

Every line below is a command that was actually run and an output that was actually observed.
Where something could not be settled in this environment it is marked **UNVERIFIED**, never PASS.

**Environment:** darwin 25.5.0, 10 cores · Node v24.18.0 · pnpm 11.10.0 · Docker 29.6.1 ·
PostgreSQL 16 container `poker-risk-lab-postgres-1` healthy on 127.0.0.1:5432.

**Isolation:** the lead auditor created database `prl_audit_lead` and used port 3501; Reviewer G
used compose project `prl-audit-g` with ports 55432/3300/3301; Reviewer D used `prl_audit_d` and
port 3101; Reviewer F used 3200/3201. The shared development database was never reset.

---

## 1. The required clean release run

| # | Gate | Command | Result |
|---:|---|---|---|
| 1 | frozen, script-disabled install | `pnpm install --frozen-lockfile --ignore-scripts` (clean copy, cold store) | **PASS** — 104 packages, 20 s (Reviewer G) |
| 2 | security / IOC checks | `pnpm run security:audit` | **PASS (exit 0)** — but see §4: 4 of 8 gates cannot fail |
| 3 | format check | `biome format .` | **PASS** — 348 files, no fixes applied |
| 4 | lint | `pnpm run lint` | **PASS (exit 0)** — 2 advisory complexity warnings in `packages/content/src/validate.ts:670,865`, both pre-disclosed |
| 5 | typecheck | `pnpm -r typecheck` | **PASS** (Reviewer G, after build) |
| 6 | unit tests | `pnpm run test:unit` | **PASS** — **741 pass / 0 fail** |
| 7 | poker invariant / property tests | engine suite + 50,000-hand soak | **PASS** — 119/119; invariants held after every one of 275,112 actions |
| 8 | integration tests | `pnpm run test:integration` | **FAIL** — **534 tests, 532 pass, 2 fail** |
| 9 | database migrations | `migrate.mjs up` on empty `prl_audit_lead` | **PASS** — 2 migrations, checksummed ledger |
| 10 | database seed | `migrate.mjs seed` | **PASS** — idempotent by design |
| 11 | WebSocket tests | smoke + load + Reviewer D's own clients | **PASS** |
| 12 | concurrency tests | load harness, 3 concurrent sessions | **PASS** — 0 errors |
| 13 | reconnect / idempotency tests | Reviewer D, independent clients | **PASS** |
| 14 | E2E tests | — | **UNVERIFIED** — no browser-driven E2E suite exists in the repo (see §5) |
| 15 | accessibility tests | `pnpm run test:a11y` + real browser | see `ux-accessibility.md` |
| 16 | load tests | `node scripts/load-test.mjs` | **PASS** |
| 17 | production web build | `pnpm run build` | **PASS** — 13.9 s from clean (Reviewer G) |
| 18 | production API build | `pnpm run build` | **PASS** |
| 19 | container builds | `docker build` both Dockerfiles | **PASS** — both images build (Reviewer G) |
| 20 | container security checks | runtime inspection of the running container | **PASS** — see §3 |
| 21 | SBOM generation | `pnpm run security:sbom` | **PASS** — regenerates byte-identical, CycloneDX 1.6 valid, 100 % complete |
| 22 | production-style startup | API + web + WebSocket from clean install | **PASS** |

### The release gate is red

```
$ pnpm run test
...
ℹ tests 534
ℹ pass 532
ℹ fail 2
EXIT=1
```

Failing tests:

```
✖ the Scenario Lab fixture is the analysis the engine produces today
   └ ✖ matches buildCoachReport for every bundled scenario
✖ the hand-review fixture is the review the builder produces today
   └ ✖ REVIEW_HAND_SHOWDOWN replays and analyses identically
```

Per-package unit results (lead auditor's own run):
`poker-engine 119/119 · contracts 21/21 · poker-math 232/232 · ui 186/186 · content 13/13 ·
poker-ai 148/148 · web 22/22` = **741 pass, 0 fail**.

`pnpm run verify` therefore cannot pass, and CI runs this command.

**The gate is red because the product ships wrong mathematics to learners.** The repo's own guard
already detects the defect; it has been left failing. Full analysis in `poker-correctness.md` §5.

> Reviewer H confirmed this is deterministic, not a stale build: it recompiled `poker-math` to a
> scratch `--outDir` and the emitted JS was identical to `dist/` bar the sourcemap line, and ran
> the suite **three times with byte-identical results**.

---

## 2. Live-service evidence gathered by the lead auditor

### Migrations and seed, from empty
```
$ migrate.mjs up          # DATABASE_URL -> prl_audit_lead
Applying 2 migration(s)
  ✓ 0001_initial.sql (184 ms, a9a5cce35ad5)
  ✓ 0002_indexes_and_constraints.sql (112 ms, 0283c0c4a0da)
$ migrate.mjs seed
  ✓ 0001_dev_seed.sql (49 ms)
```

### API startup
```
{"msg":"Server listening at http://127.0.0.1:3501"}
{"address":"http://127.0.0.1:3501","nodeEnv":"development","oidcEnabled":false,
 "allowedOrigins":["http://localhost:3000"],"routeModules":7,"msg":"listening"}
```

### Live schema security verification
```
$ node apps/api/scripts/verify-schema.mjs
schema verification
  · 121 columns across the prl schema
  · 41 indexes
  · checked 13 tables for prl_app privileges
  ✓ every documented schema security property holds
EXIT=0
```

### Load harness — the prior finding R13 (“`test:load` has never worked”) is FIXED
```
$ node scripts/load-test.mjs        # against 127.0.0.1:3501
  guest sessions          3
  rooms created           1
  joins                   2
  connections             3 established of 3 attempted
  seats taken             3
  hands completed         5 of 5
  actions sent/applied    58 / 57
  p50 0.6ms  p90 1.5ms  p99 7.6ms  max 7.6ms  n=57
  Errors  none, rate 0.000% of 70 operations
PASS
```
This also constitutes runtime proof that **three concurrent real WebSocket sessions complete full
hands**. The harness itself correctly refuses to be quoted as a capacity measurement.

> One action of 58 was not applied while the harness reported zero errors — consistent with a
> deliberate stale-sequence or idempotency rejection. Reviewer D independently confirmed both
> mechanisms behave correctly, so this is expected behaviour, not a defect.

### Strict smoke test — 44 checks
```
$ node scripts/smoke-test.mjs --strict
  ✓ 12 legend profiles served, naming mode "archetype"   (safe default)
  ✓ every profile carries at least one disclaimer
  ✓ no profile implies endorsement or a digital twin
  ✓ the room is invite-only
  ✓ an uninvited user gets 404, not 403   (the error does not confirm the room exists)
  ✓ a wrong invite code is rejected
  ✓ the WebSocket upgrade succeeded   (session cookie carried on the handshake)
  ✓ a hand was played to completion against a bot   (37 frames)
  ✓ no socket frame carried a deck, cursor or salt   (37 frames scanned)
  ✓ no live frame carried another seat's hole cards mid-hand
  ✓ an archived hand carries no opponent's unshown hole cards
  ✓ Bob's hand history does not contain Alice's hands
  ✓ progress carries no score, streak, level or rank
  ✓ guest creation is rate limited   (429 after repeated attempts)
44 check(s) passed — Smoke test passed.
```

### Health and readiness
`/api/v1/health` → 200 (liveness, rate-limit exempt); `/api/v1/ready` → 200 with a real `db.ping()`
(`apps/api/src/app.ts:200-210`), returning 503 when degraded.

The lead auditor's negative test (`CONNECTION LIMIT 0` + `pg_terminate_backend`) was
**inconclusive** — the pool retained one live backend, so the ping legitimately succeeded. This is
explicitly **not** evidence of a lying health check. Reviewer G settled it with a harder fault
injection: **readiness genuinely flips to 503 when the database is stopped, and self-heals.**
Connection limit was restored.

---

## 3. Clean-environment production results (Reviewer G)

**Counts: 10 PASS · 2 FAIL · 3 PARTIAL · 0 UNVERIFIED.**

### PASS, with runtime evidence
Clean-checkout frozen script-disabled install; boot from `.env.example` with production config
validation **exiting 78 with enumerated errors** rather than silently defaulting; idempotent seed;
web, API and WebSocket startup; readiness truthfulness; `pnpm run build` in 13.9 s from clean; both
OCI images build.

**Container security is excellent**, and was verified by inspecting the *running* container rather
than reading the `USER` line: **all five capability sets empty**, `NoNewPrivs=1`, read-only rootfs
proven by an attempted write that failed, non-root uid read from `id` inside the container, and no
secrets in any layer.

> `packages/ui` having no `dist/` is **by design**, not a build gap — it exports
> `./src/index.ts` and its `build` script is `tsc --noEmit`. Independently confirmed by the lead
> auditor. This is recorded so it is not mistaken for a defect.

### P0 — Graceful shutdown is broken for every WebSocket connection (OPS-010)
**Mechanism confirmed directly by the lead auditor.**

`apps/api/src/ws/hub.ts:189` sets `clientTracking: false`. `@fastify/websocket`'s `defaultPreClose`
guards on `if (server.clients)` (`index.js:217`), and `ws` only creates that Set when tracking is
**on** — so the close loop never runs, `server.close()` waits forever on the upgraded socket,
`app.close()` never resolves, the hub's own `onClose` cleanup (`hub.ts:228`) never runs, and the
grace deadline fires `process.exit(1)`.

Measured on the same build, with only connection state differing:

| Condition | Time | Exit |
|---|---:|---|
| idle | 0.145 s | 0 |
| **one idle WebSocket** | 10.18 s | **1** |
| `docker compose stop api` with one WebSocket | 10.62 s | **137 (SIGKILL)**, client dropped on close code 1006 |

One *idle* socket is enough; no load is required.

Two things make this release-blocking rather than a bug:

1. `docs/RUNBOOK.md:394-397,409-411` states **the exact opposite** and calls it *“a defect and is
   fixed”*.
2. `apps/api/test/shutdown.test.ts` **passes 3/3 while containing zero WebSockets** — lead auditor
   confirmed by grep: **0 matches** for `WebSocket|ws://|upgrade`. It locks in the HTTP keep-alive
   fix and never touches the one connection type the live table is built on.

Compounding it, `docker-compose.yml` sets neither `stop_grace_period` nor `SHUTDOWN_GRACE_MS`, so
Docker's 10 s timeout exactly equals the app's 10 s deadline and SIGKILL always wins.

**Every deploy while any learner has a table open is a hard kill.**

### P1 — No migration rollback path (OPS-003, PARTIAL)
Apply, ordering, idempotency and status are all verified good. But the tool offers only
`up | status | seed | reset`; `reset` is refused in production, there are no `*.down.sql` files, and
there is no stated roll-forward-only policy in place of a rollback path.

### P1 — Privilege model never exercised (OPS-008, PARTIAL)
See `security-audit.md` §Part 3. `prl_app` is correctly scoped and **proven to work** (44/44 smoke
as a `prl_api` member; CREATE/TRUNCATE/DROP/DELETE denied), but `.env.example`, `docker-compose.yml`
and both CI database jobs connect as a superuser.

### P2 — Interrupted hands leave permanent orphans (OPS-014, PARTIAL)
Nothing corrupts — hand numbering resumes, stacks restore, redaction holds. But each interrupted
hand leaves a permanent `completed_at IS NULL` row **visible in the learner's own history with null
fields**, and there is no startup reconciliation. Three accumulated during a single audit session.

### P0/P2 — Deployment documentation (OPS-015, FAIL)
- `docs/RUNBOOK.md` §11.4 backup/restore **produces an unservable database**.
- §10 states a shutdown behaviour that does not exist (see the P0 above).
- §10 gives an instruction the repo's own compose file violates.
- `docs/reviews/final-release-report.md`, referenced at `docs/REPORT.md:236` as *“the release
  decision”*, **does not exist** — independently confirmed by the lead auditor.

---

## 4. What “all gates passed” actually means

`pnpm run security:audit` exits 0. Reviewer E established by building negative controls that **4 of
its 8 gates cannot fail against real hostile input**. The statement “all 8 gates passed” is true
and materially overstates what was verified. Detail in `security-audit.md` §Part 2.

---

## 5. Explicitly UNVERIFIED

| Item | Why | Status |
|---|---|---|
| Browser-driven E2E suite | None exists in the repo. `test:a11y` is a **static** audit of server-rendered HTML and the layout guard asserts CSS **textually**; neither can observe occlusion or focus behaviour. | **UNVERIFIED** |
| OIDC authentication flow | No identity provider available; the audited instance is guest-only (`oidcEnabled:false`). | **UNVERIFIED** |
| Timing side-channels | Loopback timing is not reliable enough to make a claim. | **UNVERIFIED** |
| Production capacity | The load harness is a loopback single-process dev-database regression check and says so itself. No capacity claim is made or supported. | **N/A** |
| Deck **fairness** | Out of scope by design: the commitment proves the deck was *fixed before any action*, not that it was *chosen* honestly. The repo states this limitation accurately. | **N/A (accurately disclosed)** |

---

## 6. Version control

The project directory is **not a git repository** (`git rev-parse` fails; no `.git` present). There
is therefore no commit history, no tags, no provenance for the audited tree, and “clean checkout”
cannot be performed literally — Reviewer G approximated it by copying the source tree. Two CI
workflows exist and reference a repository that does not exist locally. Recorded as **P2** in the
final report.

---

## 7. Determinism testing performed after the reviewer round

The final challenger reported `pnpm run test` as **534 tests / 531 pass / 3 fail**, whereas Reviewer H
(3 runs) and the lead auditor (1 run) had each measured **532 pass / 2 fail**. Reviewer H additionally
reported “no flakiness observed”. That disagreement was resolved by measurement rather than by
averaging.

The lead auditor stopped **every** leftover auditor process (7 node servers across ports
3101/3200/3201/3501, several of which were writing to the shared development database) and re-ran the
integration suite four more times.

```
run1  exit=1   ℹ tests 534   ℹ pass 532   ℹ fail 2
run2  exit=1   ℹ tests 534   ℹ pass 532   ℹ fail 2
run3  exit=1   ℹ tests 534   ℹ pass 532   ℹ fail 2
   ✖ matches buildCoachReport for every bundled scenario
   ✖ REVIEW_HAND_SHOWDOWN replays and analyses identically
```

A fourth run was then executed **with a deliberately competing API instance** bound to port 3701 and
pointed at the same shared development database, to test the hypothesis that a concurrent writer
caused the challenger's extra failure:

```
contended run   exit=1   ℹ tests 534   ℹ pass 532   ℹ fail 2      (same two failures)
```

**The competing-writer hypothesis did not reproduce.** `apps/api/test/ws-socket.test.ts:851` passed in
all four of the lead auditor's runs and in all three of Reviewer H's, and failed in both of the
challenger's — which were executed on a heavily loaded machine (load average above 8). The failing
assertion is `no stack changed across the hand: [1000,1000]`, i.e. a bot had not acted before the
assertion ran, which points to **load/timing sensitivity** rather than to ordering.

**Conclusions of record:**

1. The suite has **exactly two real, deterministic failures**, and both are the stale-fixture defect.
2. It additionally contains **at least one intermittent test in the release gate**, observed failing
   twice by an independent reviewer and passing in seven other runs. Under this audit's own rule that
   intermittent failures are never ignored, this is recorded as a genuine defect (`CHAL-C`, P2) even
   though the lead auditor could not reproduce it. A gate that fails nondeterministically cannot
   distinguish a regression from noise.
3. Reviewer H's “no flakiness observed” is revised: three runs simply did not hit it. The challenger's
   “order-dependent” diagnosis is refined: a file-alone-versus-suite comparison does not by itself
   establish ordering as the cause.
