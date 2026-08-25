# Final readiness report

**Candidate SHA:** `896c9d25acbe190df4471d73771a0ac698e8abf5`
**Tree at freeze:** clean — the release manifest records `dirty: false`.
**Branch:** `production-hardening-2`
**Date:** 2026-08-25
**Host:** Darwin arm64, Node v24.18.0, pnpm 11.10.0

This candidate supersedes `b292b2ac234c`. That one was frozen with two open blockers and a
disagreement between two reviews; reconciling the disagreement found defects neither review had,
and an adversarial audit of the whole repository found more. Everything below is measured against
this SHA unless a line says otherwise.

---

## Verdict

**PRODUCTION HARDENING COMPLETE — EXTERNAL ACCESSIBILITY CERTIFICATION REQUIRED**

`pnpm run verify` exits **0**: all thirteen gates, including a supply-chain audit of eleven. The
container scan reports **zero** findings of any severity. Staging runs the candidate digests with a
62-check strict smoke over TLS, both alerting tiers are verified end to end, sixteen reliability
drills pass, backup/restore including a real scratch restore passes, and a rollback to the previous
digest pair and back was rehearsed.

Screen-reader certification remains **UNVERIFIED**: `osascript` answers `-1743` on this host and no
grant this repository can make will change that. It needs a person with VoiceOver or NVDA. That is
the one thing standing between this and a PASS string, and it is not a code defect.

---

## What changed since `b292b2ac234c`

The previous candidate was frozen with defects in it. This is not the same software.

### Correctness — chips, hands and rooms

| Defect | Consequence |
| --- | --- |
| Rate-limit bucket keyed on the **unverified** `prl_session` cookie | Any caller rotating an invented value was never counted. 60 requests, **zero** 429s, against a limit of 3 — including the limiter in front of `POST /math/equity` and its 500,000-sample ceiling |
| Two concurrent room opens built two live tables | A table that answers `ack` and never emits another frame while the socket looks healthy; a learner refused by `require()` forever after joining by invite code; a `LiveTable` `closeAll()` cannot reach |
| Settlement did not publish what it settled | A departing seat's stack never archived (chips destroyed; created in the mirror case), its durable seat never released, a hand complete-on-deal archived as completed but never started, `leaveRoom` never dropping membership |
| `mayRaise` implemented half of TDA 43-C | Two short all-ins whose increments add to a full raise **do** reopen the action. 44 wrongly-denied raises in a 30,000-hand fuzz |
| A rejected timeout left the table with no clock | The turn timer cleared `armed` and never re-armed |

### Numbers a learner is shown

- **Minimum defence frequency for a raise** was computed as if it were a bet, counting hero's own
  call as money won: a 950-chip shove published 17.4% where the answer is 13.0%.
- **The rule of 2-and-4's error figure** compared a 47-card stub against outs counted from 45, so
  its published *sign* was wrong.
- **The AI adapted to the reader at the difficulty that promises it does not**, through a second
  path the trait gate never scaled, and said so in commentary. 209 of 1,050 paired decisions
  differed at `educational`; now 0, while `expert` still differs.

### Security, privacy and onboarding

- **Federated sign-in could never have completed.** The OIDC callback schema rejected `iss`,
  `scope`, `session_state`, `authuser`, `prompt`, `hd` and `client_info`, so Google, Auth0, Okta,
  Entra and Keycloak all 400'd before the handler ran. `iss` is now validated against the
  configured issuer — the RFC 9207 mix-up defence — before the single-use attempt row is consumed.
- **`deploy/backup/backup.env` was matched by no ignore rule.** It holds the key that decrypts
  every archive.
- **The expiry sweeps had no caller.** Two tables only ever grew, and the retention promise on
  `/privacy` was honest only because it said the sweep did not run. It runs now.
- **The browser's deck-commitment proof was self-referential**, verified against the root inside
  its own payload rather than the hand's published root.
- **The first occurrence of a counted event was invisible to its own alert.** A counter series is
  created by its first increment, and `increase()`/`rate()` read only samples inside their range —
  Prometheus does not assume a series appearing mid-range began at zero. Every zero-tolerance rule
  would have missed the first event. Found by provoking a real ban against staging: the counter
  read 1 and the rule stayed silent. Those counters are primed at zero from boot.
- Four request classes were refused before the limiter and never counted; a ban wrote an audit row
  per request rather than per crossing; a transient database fault closed a socket with a code the
  client treats as permanently fatal; the Coach limit was enforced per socket and documented per
  session.
- **The schema verifier was blind** to any table the connecting role lacks a grant on — including a
  planted one holding a deck and its salts. `addMember` let five members into a two-seat room.
- **Four release-blocking supply-chain gates could be evaded.** One quote character disabled the
  floating-runner check; `FROM node AS node` bypassed digest pinning entirely.

### The base image

Debian bookworm-slim carried **60 unfixed findings — 52 HIGH, 8 CRITICAL, 14 distinct CVEs**, all
from the base's 88 OS packages. Trixie was measured and rejected (it trades 30 unfixed for 15
unfixed plus 36 *fixable*, i.e. 72 blocking findings under this policy); distroless was rejected on
shell, node path and a Node version below the `engines` floor. The base is now
`node:24.18.0-alpine3.24`, digest-pinned, 18 OS packages:

| | before | after |
| --- | ---: | ---: |
| findings at the HIGH floor, both images | 60 | **0** |
| of which CRITICAL | 8 | **0** |
| api image | 83.3 MB | 61.7 MB |
| web image | 170.6 MB | 148.2 MB |

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
| `alerts:verify` | **21 of 21, exit 0** — BOTH tiers provoked end to end: `ApiDown` (page) fired, was delivered on `/page`, resolved after recovery and did **not** raise a ticket; `RateLimitBans` (ticket) was provoked by driving the limiter past its ban threshold, was delivered on `/ticket` and did **not** page | `alerts-twotier2.log` / `.json` |
| `test:drills` | **16 of 16**, `DRILLS_EXIT=0`, wall 142.6 s | `drills-final.log` |
| `backup create` + `verify --deep` | PASS — real scratch restore in 45.9 s, dropped; census 13 tables / 899,530 rows | `backup-final.log` |
| Rollback rehearsal | candidate 200 → api stopped → **504** → previous digests 200 → candidate restored 200 with workers | `rollback-final.log` |
| Load, Alpine container | highest passing **24 seated players**, saturating at 48 on CPU and the worker queue, **0 rate-limit refusals, 0 reconnect-consistency failures** | `load-alpine.log` / `.json` |
| Screen reader | **UNVERIFIED** `-1743` | — |

### Images

| Service | Digest |
| --- | --- |
| api | `sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17` |
| web | `sha256:aa894fcfab4157a8ce5bd864cf9d6aaafa447f4ed70c114cc6cc2ba23bd320a3` |

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

1. **Screen-reader certification is UNVERIFIED.** It needs a person to listen, and nobody has.
   **This is the only item that keeps this candidate from a PASS string.**

   The reason previously recorded for it — `osascript` error `-1743` — is accurate about what the
   machine said and misleading about what it means. **-1743 refuses an AGENT permission to drive
   VoiceOver; it does not stop a person.** Pressing Command + F5 and listening needs no Automation
   grant. What has been missing is not a permission, it is half an hour of somebody's attention.

   `pnpm run certify:screen-reader` is now the way to spend it: it reads all 73 assertions out of
   [`accessibility-certification.md`](accessibility-certification.md), holds the reviewer's place
   across a resumable session, requires a quoted announcement for every `FAIL` and `SILENT`,
   refuses to call an incomplete run a pass, and stamps the result with the commit it was run
   against so `--check` calls it stale the moment `HEAD` moves. It does not certify anything — it
   records what a person heard, which is the part a machine cannot do.
2. **No provider is configured, and nobody is on call.** This is much narrower than it was.
   Both tiers are delivered over two transports — an HTTP webhook and a **real SMTP transaction**,
   verified end to end: Alertmanager opens a TCP connection, speaks a complete SMTP exchange, and
   hands over ~10 KB of RFC822 whose envelope recipient is the address the tier's routing chose and
   whose `Subject:` names the alert. Both directions are asserted: a page does not raise a ticket
   and a ticket does not page, on both transports. Destinations are **rendered** from
   `alertmanager.template.yml` at bring-up from `PRL_ALERT_*` variables, so a deployment configures
   them rather than editing a file — and the file Alertmanager loads does not exist in a clean
   checkout.

   What is still unproven: that a real provider accepts real credentials (the sink negotiates no
   TLS and asks for no AUTH), that the address is one a phone actually watches, and that anybody is
   awake. Note that `alerts:verify` asserts against the values it rendered with, so pointing it at
   a real pager fails the delivery checks by design; the run prints which values were overridden.
3. **Images carry a registry digest but no signature.** `release:artifacts --push` publishes to a
   registry and the round trip is proven — the manifest is re-fetched and re-hashed in process, and
   every local reference is deleted and pulled back by digest before the ids are compared. So
   content identity across a push/pull boundary holds, and cross-machine promotion works. What does
   not exist is **provenance**: nothing is signed, there is no transparency log, and a local
   registry is not a third party. That needs `cosign sign` / `cosign attest` in CI.
4. **Twenty of the twenty-two alert rules are loaded, agreed, grounded and evaluable, but have not
   been provoked.** Two are driven end to end — `ApiDown` for the paging tier and `RateLimitBans`
   for the ticket tier — which is what makes the two-tier rule a tested property rather than a
   configuration file.
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
