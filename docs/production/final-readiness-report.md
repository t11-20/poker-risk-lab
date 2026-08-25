# Final readiness report

**Candidate SHA:** `68394b3df5dc51f45fa7409a3541c224861dad49`
**Tree at freeze:** clean — the release manifest records `dirty: false`.
**Branch:** `production-hardening-2`
**Date:** 2026-08-25
**Host:** Darwin arm64, Node v24.18.0, pnpm 11.10.0

This candidate supersedes `b292b2ac234c`. That one was frozen with two open blockers and a
disagreement between two reviews; reconciling the disagreement found defects neither review had,
and an adversarial audit of the whole repository found more. Everything below is measured against
this SHA unless a line says otherwise.

---

## Gates from this SHA

| Gate | Result | Capture |
| --- | --- | --- |
| `pnpm run verify` | **every gate passed, `VERIFY_EXIT=0`** — 13 gates | `verify7.log` |
| `pnpm run security:audit` | 11 of 11 gates pass | inside `verify7.log` |
| API tests | **852 / 852** | inside `verify7.log` |
| Script tests | **560 / 560** | inside `verify7.log` |
| Package + web tests | engine 134, contracts 21, maths 256, ui 265, content 29, AI 156, web 358 | — |
| `test:exhaustive` | all 133,784,560 seven-card hands | inside `verify7.log` |
| `test:simulation` | 23 / 23, every profile within its declared traits | inside `verify7.log` |
| Container CVE scan | **0 blocking, 0 unfixable, 0 allowed** | `containers-final.log` / `.json` |
| `security:secrets` | pass — working tree and all history blobs | — |
| `release:artifacts` | `ARTIFACTS_EXIT=0`, manifest `dirty: false` | `artifacts.log` |
| `staging up` | `STAGING_EXIT=0`, **62-check strict smoke**, digests matched, XFF overwritten 24/24, HSTS single-sourced | `staging.log` |
| `alerts:verify` | **17 of 17, exit 0** — `ApiDown` fired at 246 s, delivered on `/page`, not `/ticket`, resolved after recovery | `alerts-final.log` / `.json` |
| `test:drills` | **16 of 16**, `DRILLS_EXIT=0`, wall 142.6 s | `drills-final.log` |
| `backup create` + `verify --deep` | PASS — real scratch restore in 45.9 s, dropped; census 13 tables / 899,530 rows | `backup-final.log` |
| Rollback rehearsal | candidate 200 → api stopped → **504** → previous digests 200 → candidate restored 200 with workers | `rollback-final.log` |
| Load, Alpine container | highest passing **24 seated players**, saturating at 48 on CPU and the worker queue, **0 rate-limit refusals, 0 reconnect-consistency failures** | `load-alpine.log` / `.json` |
| Screen reader | **UNVERIFIED** `-1743` | — |

### Images

| Service | Digest |
| --- | --- |
| api | `sha256:bbfd0269b8798bb963def8c5b775c9b88ab5c89a72b862d6fe2332417278cd78` |
| web | `sha256:7c2c1ce9ff1c28fe4eb00922e8f3cd33ed7664caf8596fade7113cd75c0bbdf1` |

Local BuildKit store. **Not registry-attested** — nothing is pushed, so no registry vouches for
them. That is unchanged and remains a residual.

### The musl question, answered as far as it can be here

Moving to Alpine put the Monte Carlo worker pool and the Postgres client on musl for the first
time. What is now measured: both images build and scan at zero; the compiled `WorkerPool` warms and
runs a sharded Monte Carlo to correct numbers inside the image; the API and web images boot,
healthcheck and serve; DNS resolves both families; and the API image sustained a load ramp to
saturation with zero reconnect-consistency failures, saturating on CPU and the worker queue exactly
as the Debian build did. What is still not measured: hours of sustained running, and pool behaviour
under a real network partition.

---

## Residual — what is still open, in order of how much it matters

1. **Screen-reader certification is UNVERIFIED and cannot be done from here.** `osascript` answers
   `-1743`; the fix is a person granting Automation access to their terminal *and then listening*.
   [`accessibility-certification.md`](accessibility-certification.md) carries the procedure and the
   exact blocker. **This is the only item that keeps this candidate from a PASS string.**
2. **No human is paged.** Alert delivery is verified to a receiver and the two-tier routing is
   enforced by configuration; the last hop — a real paging provider and a real ticket queue — is two
   URLs in `alertmanager.yml` and is not deployed.
3. **Digests are local, not registry-attested.**
4. **Twenty-one of the twenty-two alert rules are loaded, agreed, grounded and evaluable, but have
   not been provoked.** Only `ApiDown` is driven end to end.
5. **The legal register is not closed.** `legal-review-requirements.md` is a launch blocker in its
   own right and needs counsel, not engineering: operator identity, governing law, the age
   threshold, retention *periods*, and whether erasure must delete hand history rather than detach
   it. The engineering follow-ups it depended on are done — the sweeps run, `.env.example` carries
   every variable, and the audit harnesses refuse an age-gated route rather than passing it.
6. **The age gate has no browser-level test.** Its pure decisions are covered; that a redirect and a
   `Set-Cookie` reach a real browser is not. The shipped default leaves the gate off.
7. **`slow-simulation` is sensitive to a busy host** — it fails under contention and passes
   isolated, which is a property of the drill rather than of the system.
8. **The secret scanner's stated blind spots**: a credential split across two literals, a
   word-shaped password, and generic detectors bounded at 4,096 characters per line. Provider-token
   shapes are matched at any length; the limits are documented in the file rather than implied.

PRODUCTION HARDENING COMPLETE — EXTERNAL ACCESSIBILITY CERTIFICATION REQUIRED
