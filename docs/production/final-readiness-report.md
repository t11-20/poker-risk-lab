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

Screen-reader certification is **UNVERIFIED** (`osascript` System Events **-1743**). `pnpm run verify` on this SHA exited **0**. Consecutive smokes, isolated drills, backup/restore, same-digest staging (including proxy `--force-recreate`), and rollback succeeded. That is not `RELEASE CANDIDATE: PASS` and not `PRODUCTION READY: PASS`.

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
| Container CVE | 0 blocking, 60 unfixable HIGH | `containers.log` |
| Staging same-digest + TLS smoke | `STAGING_UP_EXIT=0`, 61 checks, proxy recreate, HSTS, XFF overwrite | `staging.log` |
| Rollback | 504 on stop → previous digest ready → candidate restored | `rollback.log` |
| Screen-reader | **UNVERIFIED** `-1743` | `screen-reader-blocked.log` |
| Alert delivery | **UNVERIFIED** (no Alertmanager in staging compose) | `alert-fire.log` (conditions observed) |

`verify` includes: security:audit (IOC, SBOM, OSV, container scan of then-current images), hygiene, lint, build, typecheck, contrast, **test**, a11y, **ax 46/0**, csp, exhaustive, simulation, db:verify.

The previous freeze’s `verify` failed `test:ax` because `--start` without `--with-api` audited `/lab/fl-same-cards-under-the-gun` as “This scenario could not be loaded” whenever nothing answered on `:3001`. Root cause fixed: `pnpm run test:ax` now passes `--with-api`. Isolated re-run 46/0; full `verify` then 0.

---

## Worker / capacity

Workers: Monte Carlo off the event loop; bounded queue; crash/timeout recover. Pre-warm awaited before `listen`; `/ready` includes `workers`. Cold Coach ~3.0 s on a cold thread; after ready, not the cold path (`worker-tests.log`).

Capacity (API tree `git diff 4a17e3c b292b2a -- apps/api packages apps/web` is empty): one instance saturates at **96** zero-think VUs (error-rate 1.37%, all `service_unavailable` from the worker queue). Highest passing level **72**. Recommended ceiling **36**. See [`load-test.md`](load-test.md).

---

## Staging / 348f75b

`scripts/staging.mjs` recreates **only** the TLS proxy (`up -d --force-recreate proxy`) after `compose up`, so nginx re-reads a renewed bind-mounted cert without touching api/web digests. Coverage: `refreshStagingProxy` is exported and driven with a fake compose runner (`scripts/staging.test.mjs`, in `pnpm run test` / verify). Live `staging up` on this SHA’s images logged `waiting — proxy:running/starting` then digest match and TLS `/ready` 200 with workers.

---

## Challenge

Prior independent review of production code (`4a17e3c`, identical `apps/api`/`apps/web` to this SHA): **no P0, no P1**. P2: `/ready` workers latch not crash-aware; audit absence 250 ms sleep; `next start` rewrite frozen; image HEALTHCHECK is `/health` only.

---

## Residual

1. Screen-reader unspoken — [`accessibility-certification.md`](accessibility-certification.md) Journey 4 is `/lab/fl-same-cards-under-the-gun` (not the 404 `preflop-open-cutoff`).
2. Alert paging not deployed.
3. 60 unfixable Debian HIGH CVEs.
4. Digests are local, not registry-attested.
5. `slow-simulation` is sensitive to a busy host (contended FAIL, isolated PASS).

PRODUCTION HARDENING COMPLETE — EXTERNAL ACCESSIBILITY CERTIFICATION REQUIRED
