# Final readiness report

**Candidate SHA:** `b292b2ac234cb586f253ad42ec0ef4d949fa332b`
**Tree at freeze:** clean (`git status --porcelain` empty at `{SCRATCH}/candidate-sha.txt`).
**Last application commit:** `ef0edc7` (test:ax starts an API). Later commits `c969163` and `53faed7` are docs-only; they are not this evidence base.
**Date:** 2026-08-22
**Host:** Darwin arm64, macOS 26.5.2, Node v24.18.0, pnpm 11.10.0

`{SCRATCH}`:
`/var/folders/7s/l9fr0tyd4wn9vp8qhg9yv7g80000gn/T/grok-goal-843cf6607006/implementer`

Every capture cited below starts with `SHA=b292b2ac234cb586f253ad42ec0ef4d949fa332b` except `staging.log` (host HEAD had moved to a docs-only commit when that process started; it still deployed this SHA’s images) and `rollback.log` (same). Image manifest `commit.sha` is this SHA, `dirty=false`.

---

## Verdict

**PRODUCTION HARDENING COMPLETE — EXTERNAL ACCESSIBILITY CERTIFICATION REQUIRED**

Screen-reader certification is **UNVERIFIED** (`osascript` System Events **-1743**, re-confirmed 2026-08-24). `pnpm run verify` on this SHA exited **0**. Consecutive smokes, isolated drills, backup/restore, same-digest staging (including proxy `--force-recreate`), and rollback succeeded. That is not `RELEASE CANDIDATE: PASS` and not `PRODUCTION READY: PASS`.

Two of the gaps that stood behind that verdict have since been closed — **alert delivery is now verified** (16/16, exit 0) and **secret scanning is now a first-party gate**, which found a real hole in the ignore rules. Neither touched the application tree. The one thing that still keeps this from any PASS string is the screen reader, and no amount of work in this repository will change it. See [Reconciling two release reviews](#reconciling-two-release-reviews) and [What changed after the freeze](#what-changed-after-the-freeze).

---

## Images

Built once: `node scripts/release-artifacts.mjs --force` (`{SCRATCH}/containers-build.log`, `ARTIFACTS_EXIT=0`).

| Service | Digest (local BuildKit store, not registry-attested) |
| --- | --- |
| api | `sha256:3854174f36184bb14cf2bf0b6912fbc199a804b230c392111c0a58943d92e36f` |
| web | `sha256:2bc457c546bf3b8edd379c610199b18f0c1b06ebc61bdb83183755df31a8bd88` |

`{SCRATCH}/digests.txt`. Previous pair used for rollback: api `sha256:9a8457e8…`, web `sha256:34ba7932…` (`prl-*:4a17e3cec3a6`).

---

## Gates from this SHA

| Gate | Result | Capture |
| --- | --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` | Already up to date, `INSTALL_EXIT=0` | `frozen-install.log` |
| `pnpm run verify` | **every gate passed, `VERIFY_EXIT=0`** | `verify.log` |
| Worker pool tests | 44/0 | `worker-tests.log` |
| Keyboard | 142 passed, `KEYBOARD_EXIT=0` | `keyboard.log` |
| Two consecutive strict smokes | 62/62 twice, `SMOKE1_EXIT=0` `SMOKE2_EXIT=0`, isolation via reset token (refused in production) | `smoke-consecutive.log` |
| Drills | Isolated: 16/16, `DRILLS_EXIT=0`. A parallel run during verify failed `slow-simulation` (second overrun 200); that log is `drills-contended-with-verify.log`. | `drills.log` |
| Backup create / verify --deep / restore | all PASS; schema verify + `/ready` on restored DB | `backup-restore.log` |
| Container CVE | 0 blocking, 60 unfixable — **52 HIGH and 8 CRITICAL**, 14 distinct CVEs | `containers.log`; re-scanned 2026-08-24 |
| Staging same-digest + TLS smoke | `STAGING_UP_EXIT=0`, 61 checks, proxy recreate, HSTS, XFF overwrite | `staging.log` |
| Rollback | 504 on stop → previous digest ready → candidate restored | `rollback.log` |
| Screen-reader | **UNVERIFIED** `-1743` | `screen-reader-blocked.log` |
| Alert delivery | **UNVERIFIED at the freeze** (no Alertmanager in staging compose). Verified afterwards, 16/16 — see [What changed after the freeze](#what-changed-after-the-freeze) | `alert-fire.log` (conditions observed); `alert-delivery2.log` |

`verify` includes: security:audit (IOC, SBOM, OSV, container scan of then-current images), hygiene, lint, build, typecheck, contrast, **test**, a11y, **ax 46/0**, csp, exhaustive, simulation, db:verify.

The previous freeze’s `verify` failed `test:ax` because `--start` without `--with-api` audited `/lab/fl-same-cards-under-the-gun` as “This scenario could not be loaded” whenever nothing answered on `:3001`. Root cause fixed: `pnpm run test:ax` now passes `--with-api`. Isolated re-run 46/0; full `verify` then 0.

---

## Worker / capacity

Workers: Monte Carlo off the event loop; bounded queue; crash/timeout recover. Pre-warm awaited before `listen`; `/ready` includes `workers`. Cold Coach ~3.0 s on a cold thread; after ready, not the cold path (`worker-tests.log`).

Capacity (API tree `git diff 4a17e3c b292b2a -- apps/api packages apps/web` is empty): one instance saturates at **96** zero-think VUs (error-rate 1.37%, all `service_unavailable` from the worker queue). Highest passing level **72**. Recommended ceiling **36**. See [`load-test.md`](load-test.md), which now also carries a second
measurement on a contended host and the reconciliation of the two reviews' capacity figures — the
short version being that a ramp against a process with stock rate limits produces no capacity
figure at all, and the harness says so.

---

## Staging / 348f75b

`scripts/staging.mjs` recreates **only** the TLS proxy (`up -d --force-recreate proxy`) after `compose up`, so nginx re-reads a renewed bind-mounted cert without touching api/web digests. Coverage: `refreshStagingProxy` is exported and driven with a fake compose runner (`scripts/staging.test.mjs`, in `pnpm run test` / verify). Live `staging up` on this SHA’s images logged `waiting — proxy:running/starting` then digest match and TLS `/ready` 200 with workers.

---

## Challenge

Prior independent review of production code (`4a17e3c`, identical `apps/api`/`apps/web` to this SHA): **no P0, no P1**. P2: `/ready` workers latch not crash-aware; audit absence 250 ms sleep; `next start` rewrite frozen; image HEALTHCHECK is `/health` only.

---

## Reconciling two release reviews

Two independent reviews of this candidate reached different verdicts — `RELEASE: FAIL` and
`PRODUCTION HARDENING COMPLETE` — and disagreed on facts, not only on judgement. Each disputed
point was re-checked. Three were the reviews describing different things with the same words,
two were errors of fact, two were real gaps that have since been closed, and two are unchanged
and still open.

| Point | Review 1 said | Review 2 said | What is true |
| --- | --- | --- | --- |
| The frozen candidate | code `ef0edc7`, clean HEAD `53faed7` | evidence SHA `b292b2a` | **Both, describing different things.** `ef0edc7` is the last application commit; `b292b2a` is the SHA every capture is stamped with; `c969163`, `53faed7` and `5e3cbbc` after it are docs-only. `git diff ef0edc7 b292b2a -- apps packages` is empty. |
| Capacity | "saturated at 6 seated players; conservative ceiling 3" | 96 saturating, 72 highest passing, ceiling 36 | **Review 1's figure is not a capacity measurement.** It is the shape a ramp takes against a process whose rate limits are stock: the harness stops at the first level with a refusal and prints *"no level met every threshold, so there is no capacity figure"*. Reproduced three ways in [`load-test.md`](load-test.md). |
| Strict image scan | "failed with 60 unfixed HIGH/CRITICAL" | "0 blocking, 60 unfixable HIGH" | **Both misstate the severity split**, in opposite directions. There are 60 unfixed findings: **52 HIGH and 8 CRITICAL**, 14 distinct CVEs across two identical Debian bases. Under this repository's policy the scan passes with 0 blocking — re-verified 2026-08-24. `--include-unfixed` fails by design and is a different policy from the one that ships; see [`staging-verification.md`](staging-verification.md). |
| Final-SHA image manifest | "missing" | present | **Present.** `deploy/staging/release-manifest.json`, `commit.sha` `b292b2a`, `dirty: false`, both digests resolving on this machine. It is *gitignored* — a per-machine build record must not be committed — which is the likely reason a reviewer looking in git did not find it. |
| Registry-attested staging | missing | acknowledged missing | **Agreed and unchanged.** Digests are local BuildKit manifest digests. Nothing is pushed; no registry vouches for them. |
| External alert delivery | "unavailable" | "UNVERIFIED (no Alertmanager)" | **Was true. Now closed** — see below. |
| Standalone secret scanning | "unavailable" | not raised | **Was true. Now closed**, and it found a real hole — see below. |
| Destructive drills, `backup verify --deep` | "not run under the hard destructive-command policy" | drills 16/16 isolated, backup PASS | **Review 2's captures exist and are stamped `b292b2a`.** Review 1 could not run them under its own harness's restrictions, which is a limit on that review rather than a finding about the system. They were not re-run in this pass; the frozen captures stand. |
| Screen-reader certification | UNVERIFIED | UNVERIFIED | **Agreed, and re-confirmed 2026-08-24**: `osascript` still answers `-1743`. |

---

## What changed after the freeze

The application tree did not. `git diff b292b2a HEAD -- apps packages` is empty and the working
tree adds nothing under either, so **the candidate images remain the artefacts described above**.
What follows is tooling, one deployment overlay, and documentation.

### Alert delivery — was UNVERIFIED, now verified with stated limits

`docs/production/alerts.md` described 22 rules that had never been evaluated, and ended by
admitting it described intent. There is now a Prometheus and an Alertmanager
(`docker-compose.observability.yml`, an **overlay** — the staging manifest is untouched), the
rules exist as `deploy/staging/observability/alert-rules.yml`, and `pnpm run alerts:verify`
returned **16 of 16 checks, exit 0** against the running candidate images.

It establishes four things about all 22 rules — loaded with no evaluation error, in agreement
with the document, every `prl_*` series present in a live scrape, every expression evaluating —
and one thing about one of them: `ApiDown` was provoked by stopping the API container, fired
after 248 s, reached Alertmanager, was delivered to the paging receiver and **not** to the ticket
receiver, and produced a resolved notification when the API came back.

**It does not prove a human is reached.** Both receivers are a local webhook sink; production
replaces two URLs. Twenty-one rules were checked but not provoked.

### Secret scanning — was unavailable, now a first-party gate

`security:secrets` (`scripts/supply-chain/secret-scan.mjs`), dependency-free and offline, wired
into `security:audit` as its eleventh gate. It reads tracked files for credential shapes and —
the half that mattered — asserts that an ignore rule exists for every path this deployment's own
documentation tells an operator to create with a secret in it.

**It found a real hole.** `deploy/backup/backup.env` holds `PRL_BACKUP_KEY`, the key that
decrypts every archive ever taken with it, and the backup role's database password.
`deploy/backup/README.md` instructs an operator to create it. **No ignore rule matched it**,
while `.env` and `deploy/staging/tls/` were both covered. One `git add -A` on a backup host
would have committed it, and no working-tree scan could have caught it first because on every
machine that runs the gates that file does not exist. The rule is now in `.gitignore` and the
gate asserts it, from `git check-ignore` rather than by reading the file.

`docs/production/security.md` also claimed `security:hygiene` enforced that `.env` was
gitignored. It never did — that gate reads source files for hidden characters. The claim is
corrected and the control is now actually asserted.

Working tree and full git history (1,006 unique blobs) are both clean.

### Two harness defects found while reconciling the capacity dispute

Both in `scripts/load-test.mjs`, both with negative controls in `load-test.test.mjs`:

1. The `db-pool` saturation signal compared a histogram **bound** against its threshold with
   `>=`. A bound of 50 ms means "99% of probes finished within 50 ms" — the threshold being met
   — so it blamed the database for every reading inside the 25–50 ms bucket, including a
   three-player level at 0.4 requests per second. The report printed `db probe p99 <= 50.0ms`
   and `db-pool FIRED 50.00 ms (threshold 50 ms)` on the same screen.
2. `histogramBoundAtQuantile` returned `null` both for "no observations" and for "the quantile
   fell in the `+Inf` bucket". Downstream, `null` means "not exported by this build" — so the
   slowest reading the histogram can produce was indistinguishable from an absent metric, and
   the signal stayed quiet for it.

A ramp stopped by the rate limiter now also says, beside the number, that the concurrency is a
configured ceiling and not a capacity — the misreading that produced the disputed figure.

### Evidence from this pass

Every capture is stamped `SHA=5e3cbbc` with the working tree carrying the changes above; the
application tree under `apps/` and `packages/` is byte-identical to the frozen candidate.

| Gate | Result | Capture |
| --- | --- | --- |
| `pnpm run verify` | **every gate passed, `VERIFY_EXIT=0`** — 13 gates including the audit's new eleventh. API **812/812** (unchanged); scripts **454/454**, up from 422 — the 32 new cases are the two gates added here and the two harness regressions | `verify2.log` |
| `pnpm run security:audit` | 11 of 11 gates pass, `secret-scan` among them | inside `verify2.log` |
| `security:secrets` (working tree) | PASS — 621 files read, 7 secret-bearing paths checked against the ignore rules | — |
| `security:secrets --history` | PASS — 1,006 unique blobs | — |
| `security:containers` | 0 blocking, 60 unfixable (8 CRITICAL, 52 HIGH), 0 allowed | `containers.log` / `.json` |
| `pnpm run alerts:verify` | **16 of 16, exit 0** — `ApiDown` fired 256 s after the stop, delivered on `/page`, resolved after recovery | `alert-delivery3.log` / `.json` |
| `pnpm run test:drills` | **16 of 16, `DRILLS_EXIT=0`**, wall 142.2 s, isolated | `drills.log` |
| `backup create` | PASS | `backup.log` |
| `backup verify --deep` | PASS — all four layers; restored into a scratch database and dropped it (40.1 s), row census 13 tables / 899,267 rows | `backup.log` |
| Load, stock limits | harness refused to run; no numbers | `load-stock.log` |
| Load, guest limit only | stopped at 3 players on `refusal-rate-limited`; "no capacity figure" | `load-guestraised.log` / `.json` |
| Load, all limits raised | highest passing 48, saturated at 72, resource event-loop, 0 rate-limit refusals | `load-raised.log` / `.json` |
| Screen reader | **UNVERIFIED**, `-1743` re-confirmed | — |

The drills and `backup verify --deep` are the two items Review 1 could not run under its own
harness's restrictions. They are re-run here rather than quoted from the freeze, so both reviews
now have the same evidence in front of them.

### Smaller corrections

- `WebSocketConnectionsHigh` was a placeholder of 400 that `alerts.md` flagged as a tracked
  task. It is now **67**, 70% of the measured saturation point, as that document requires.
- `container-scan.mjs` prints the severity breakdown of unfixed findings and names unfixed
  CRITICALs on their own line, because "60 unfixable HIGH" is how both reviews recorded 52 HIGH
  and 8 CRITICAL.
- The supply-chain gate count in `README.md`, `docs/REPORT.md`, `docs/RUNBOOK.md` and
  `docs/SECURITY.md` said nine. It was ten; it is now eleven.

---

## Residual

1. **Screen-reader certification is UNVERIFIED** and cannot be done from here —
   [`accessibility-certification.md`](accessibility-certification.md). Journey 4 is
   `/lab/fl-same-cards-under-the-gun` (not the 404 `preflop-open-cutoff`).
2. **No human is paged.** Delivery is verified to a receiver; the last hop is not deployed.
3. **60 unfixed Debian findings — 52 HIGH, 8 CRITICAL.** Policy is not to block on a finding
   with no available fix; the only remediation is a different base image.
4. **Digests are local, not registry-attested.**
5. `slow-simulation` is sensitive to a busy host (contended FAIL, isolated PASS).
6. Twenty-one of the twenty-two alert rules are loaded, agreed, grounded and evaluable, but
   have not been provoked.

PRODUCTION HARDENING COMPLETE — EXTERNAL ACCESSIBILITY CERTIFICATION REQUIRED
