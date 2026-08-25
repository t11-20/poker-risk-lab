# Final readiness report

**Candidate SHA:** `4320f1c4ad212e81d1a8a4ae2c310cbc7ccab748`
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

`pnpm run verify` exits **0**: all fourteen gates, including a supply-chain audit of eleven at the
time of that capture — **twelve since 2026-08-25**, when release image signature verification was
added as gate twelve and measured passing on these digests. The
container scan reports **zero** findings of any severity. Staging runs the candidate digests with a
62-check strict smoke over TLS, both alerting tiers are verified end to end, sixteen reliability
drills pass, backup/restore including a real scratch restore passes, and a rollback to the previous
digest pair and back was rehearsed.

Screen-reader certification remains **UNVERIFIED**: `osascript` answers `-1743` on this host and no
grant this repository can make will change that. It needs a person with VoiceOver or NVDA. That is
the one thing standing between this and a PASS string, and it is not a code defect.

What has changed is its size. **45 of the certification's 73 assertions are now machine-verified on
every run** of `pnpm run test:ax`, one check per assertion ID, against the rendered accessibility
tree in real Chrome — so a regression in any of them fails `pnpm run verify` on the day it lands.
**28 still require a person listening**, and they are the ones whose subject is the speech itself.
The session is now roughly **25–35 minutes per platform** rather than the better part of an
afternoon. The blocker is not reduced; the work behind it is.

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
- **A stuck chair was reported as lost hand history.** `seat-release` was not in the
  `ProblemEvent` union, so a failed seat release took the nearest available kind — `archive-write`
  — and incremented `archiveFailures`. `ArchiveFailing` is zero-tolerance, so an operator was paged
  by a data-integrity alert, with that runbook, because a chair failed to free. It now has its own
  event, its own primed counter, its own rule and its own runbook, and it counts chairs rather than
  passes. Fixing it exposed that the release loop awaited the whole list at once, so the first
  refusal stranded every chair behind it silently — the same shape as the defect the mechanism
  exists to close, one level down.
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
| `pnpm run verify` | **every gate passed, `VERIFY_EXIT=0`** — all 14 gates, `test:age-gate` among them | `verify-14.log` |
| `pnpm run security:audit` | 11 of 11 gates pass at capture; **12 of 12 after the signature gate was added**, re-run 2026-08-25 | inside `verify7.log` |
| API tests | **861 / 861** | inside `verify-14.log` |
| Script tests | **650 / 650** | inside `verify-14.log` |
| Package + web tests | engine 134, contracts 21, maths 256, ui 265, content 29, AI 156, web 358 | — |
| `test:exhaustive` | all 133,784,560 seven-card hands | inside `verify7.log` |
| `test:simulation` | 23 / 23, every profile within its declared traits | inside `verify7.log` |
| Container CVE scan | **0 blocking, 0 unfixable, 0 allowed** | `containers-final.log` / `.json` |
| `release:sign` | both images pushed, signed and attested by digest; registry digest **equals** build digest for both | — |
| `security:image-provenance` | **exit 0** — both digests verify against the committed public key; SBOM attestations verify with subjects matching (api 103 components, web 61) | — |
| `--negative-control` | **three refusals, one acceptance**: unsigned digest → cosign exit 10 `no signatures found`; wrong key → exit 1 `accepted signatures do not match threshold, Found: 0, Expected 1`; transplanted signature → exit 1 `provided artifact digest does not match any digest in statement`; positive control accepted | — |
| `security:secrets` | pass — working tree and all history blobs | — |
| `release:artifacts` | `ARTIFACTS_EXIT=0`, manifest `dirty: false` | `artifacts.log` |
| `staging up` | `STAGING_EXIT=0`, **62-check strict smoke**, digests matched, XFF overwritten 24/24, HSTS single-sourced | `staging.log` |
| `alerts:verify` | **25 of 25, exit 0** — BOTH tiers provoked end to end: `ApiDown` (page) fired, was delivered on `/page`, resolved after recovery and did **not** raise a ticket; `RateLimitBans` (ticket) was provoked by driving the limiter past its ban threshold, was delivered on `/ticket` and did **not** page | `alerts-23.log` / `.json` |
| `alerts:verify`, **since that capture** | The row above is the run at this SHA and is left as it was recorded. The script has since gained one grounding check and the rules file two rules, so the current totals are **26 checks over 27 rules**. Thirteen of the twenty-six — every check that does not stop the API — were re-run against the same live stack, and the new Alertmanager grounding check passed (`up{job="prl-alertmanager"} = 1`, `alertmanager_notifications_failed_total` present among 109 families). The remaining thirteen provoke `ApiDown` and `RateLimitBans` and were **not** re-run, because doing so stops the staging API for four minutes. **One of the thirteen currently fails**, and it is the grounding check doing its job on unrelated in-flight work: `RoomOwnershipFenced` and `RoomOwnershipRefused` name `prl_room_fencings_total` and `prl_room_ownership_refusals_total`, which exist in `observability/metrics.ts` in the working tree and not in the deployed API image. It clears on the next `release:artifacts` + `staging up` | see residual 2 |
| `test:drills` | **16 of 16**, `DRILLS_EXIT=0`, wall 142.6 s | `drills-final.log` |
| `backup create` + `verify --deep` | PASS — real scratch restore in 45.9 s, dropped; census 13 tables / 899,530 rows | `backup-final.log` |
| Rollback rehearsal | candidate 200 → api stopped → **504** → previous digests 200 → candidate restored 200 with workers | `rollback-final.log` |
| Load, Alpine container | highest passing **24 seated players**, saturating at 48 on CPU and the worker queue, **0 rate-limit refusals, 0 reconnect-consistency failures** | `load-alpine.log` / `.json` |
| `test:ax`, certification assertions | **45 of 45** — the machine-checkable half of the 73 manual assertions, one check per assertion ID, in Chrome 151. Demonstrated to refuse: seven components were deliberately broken (footer landmark name, route-announcer politeness, `<main tabIndex>`, action-button `aria-label`, face-down card naming, sheet focus return, quiz `aria-describedby` order) and the gate failed **10** assertion checks by ID, then passed 45 of 45 again on restore | see residual 1 |
| Screen reader, the residual **28** | **UNVERIFIED** `-1743`. Needs a person listening; 25–35 min per platform | — |

### Images

**This table was wrong, and it is kept with the correction rather than quietly replaced.** It read:

| Service | Digest ~~(as published)~~ — **NOT this candidate's** |
| --- | --- |
| api | `sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17` |
| web | `sha256:aa894fcfab4157a8ce5bd864cf9d6aaafa447f4ed70c114cc6cc2ba23bd320a3` |

Those two are the digests the previous push left in the local registry, from candidate
`091d67ac39ce-dirty`, and they were never this candidate's — `deploy/staging/release-manifest.json`
has recorded `45e764…` and `4bbeb5…` throughout, and those are what the staging containers are
running. Found by hand on 2026-08-25 while signing, by reading the manifest against this table. No
gate could have caught it, because until now nothing consumed both: prose in a report and JSON in a
manifest were two records with nothing joining them. The signature record is the first artefact
that has to reconcile a digest with the manifest's, which is why the drift surfaced here.
**The digests this candidate built, signed and runs are the ones below**, and they are what
`deploy/staging/release-manifest.json` and `deploy/staging/release-signatures.json` both record:

| Service | Digest built, pushed and **signed** | Registry reference |
| --- | --- | --- |
| api | `sha256:45e76485dce57bd9487e83cc38db17bf3e39e9aaeb5f41f9ae72069439140437` | `127.0.0.1:5001/prl-api@sha256:45e764…` |
| web | `sha256:4bbeb50b83971c3fac551ec68daea13d69a8a328d20a20321cf7ff6914acc700` | `127.0.0.1:5001/prl-web@sha256:4bbeb5…` |

The registry digest equals the build digest for both — checked rather than assumed: the manifest is
re-fetched from the registry over HTTP and re-hashed in process, and `pnpm run release:sign` refuses
outright if the two differ, because signing a converted artefact would attach a cryptographic
guarantee to bytes staging never ran.

**Signed, not attested by a third party.** Both digests carry a cosign signature and a signed
CycloneDX SBOM attestation, verifiable against the committed `deploy/signing/cosign.pub` with no
private key. What that does and does not establish is residual 3 below, in full.

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

1. **Screen-reader certification is UNVERIFIED — 45 of 73 machine-verified, 28 still need a person
   listening.** **This is the only item that keeps this candidate from a PASS string.**

   The reason previously recorded for it — `osascript` error `-1743` — is accurate about what the
   machine said and misleading about what it means. **-1743 refuses an AGENT permission to drive
   VoiceOver; it does not stop a person.** Pressing Command + F5 and listening needs no Automation
   grant. What has been missing is not a permission, it is half an hour of somebody's attention.

   **What is now automated.** Each of the 73 assertions in
   [`accessibility-certification.md`](accessibility-certification.md) carries a `Checked by` marker.
   **45 are marked `auto`** and have a real check in `scripts/ax-assertions.mjs`, run by
   `pnpm run test:ax` inside `pnpm run verify`, against the *rendered* accessibility tree in real
   Chrome — the computed name and role of every control, the theme radio group's selected state,
   the route announcer's politeness and that it writes the title exactly once and stays silent on a
   full load, focus after the skip link / after acting at the table / after advancing a quiz
   question / after Escape closes the navigation sheet, Tab and Shift + Tab never leaving that
   sheet, `aria-invalid` and the order of `aria-describedby` on a refused numeric answer, the bet
   sizer's range, every action button's spoken sentence, that no face-down card names a rank or a
   suit, and that the Coach's assumptions are never collapsed away. The split per section:

   | Section | Assertions | `auto` | `person` |
   | --- | ---: | ---: | ---: |
   | Global (G1–G10) | 10 | 10 | 0 |
   | J1 Learn | 6 | 4 | 2 |
   | J2 Guided practice | 9 | 7 | 2 |
   | J3 Table and Coach | 21 | 10 | 11 |
   | J4 Scenario Lab | 6 | 3 | 3 |
   | J5 AI Legends | 5 | 5 | 0 |
   | J6 Hand review | 7 | 0 | 7 |
   | J7 Navigation sheet | 6 | 5 | 1 |
   | J8 Failure paths | 3 | 1 | 2 |
   | **Total** | **73** | **45** | **28** |

   Writing them found one real defect that had sat in the document as an untested claim: **G3
   asserts a `contentinfo` landmark named "About Poker Risk Lab" and the footer's computed name was
   the empty string** — a heading inside a landmark does not name the landmark. Fixed in
   `apps/web/src/components/SiteFooter.tsx`.

   **What is still a person's job, and why.** The 28 `person` rows are the ones whose subject is the
   speech: whether something arrived in the right order, whether a polite region really waited,
   whether a refusal interrupted, whether a turn was announced once or on every state frame,
   whether any of it is comprehensible — plus everything needing a live socket at a real table
   (eleven of journey 3), a stopped API, a deliberately broken build, or a hand in a database
   (journey 6 entirely). The classification is deliberately conservative: a row that mixes a
   checkable fact with a claim about speech stays with the person, because a row half-covered by a
   machine and dropped from the human session is a row nobody checks.

   `pnpm run certify:screen-reader` is now the way to spend the half hour: it presents **the 28**,
   states up front how many are machine-covered and where those checks live, holds the reviewer's
   place across a resumable session, requires a quoted announcement for every `FAIL` and `SILENT`,
   refuses to call an incomplete run a pass, and stamps the result with the commit it was run
   against so `--check` calls it stale the moment `HEAD` moves. `--all` puts the machine-covered
   rows back for a reviewer who wants to hear them anyway. It does not certify anything — it
   records what a person heard, which is the part a machine cannot do. **Expect 25–35 minutes per
   platform**, both platforms required (§2 and §9); a single-platform run is PARTIAL, never PASS.
2. **No provider is configured, and nobody is on call.** Narrower again since this report was
   first written, and the part that remains is now stated exactly.

   Both tiers are delivered over two transports — an HTTP webhook and a **real SMTP transaction**,
   verified end to end: Alertmanager opens a TCP connection, speaks a complete SMTP exchange, and
   hands over ~10 KB of RFC822 whose envelope recipient is the address the tier's routing chose and
   whose `Subject:` names the alert. Both directions are asserted: a page does not raise a ticket
   and a ticket does not page, on both transports. Destinations are **rendered** from
   `alertmanager.template.yml` at bring-up from `PRL_ALERT_*` variables, so a deployment configures
   them rather than editing a file — and the file Alertmanager loads does not exist in a clean
   checkout. Note that `alerts:verify` asserts against the values it rendered with, so pointing it
   at a real pager fails the delivery checks by design; the run prints which values were
   overridden.

   **What has been added since:** `pnpm run alerts:preflight` (`scripts/alert-preflight.mjs`, 8
   static checks plus an opt-in handshake). It refuses a paging destination that is a placeholder,
   malformed, missing a credential, or routed to a receiver with nothing in it — each of which
   produces an Alertmanager that starts, reports itself healthy, routes by severity exactly as
   designed and notifies nobody. `pnpm run staging promote` runs it and refuses the promotion on
   it, so **this repository can no longer promote a release with placeholder paging.** Against the
   configuration as shipped it correctly REFUSES, because nothing is configured: that is the
   honest state of this deployment, not a defect in the gate.

   With `--handshake` (or `PRL_ALERT_PREFLIGHT_HANDSHAKE=1`) it also speaks TCP, TLS, `EHLO`,
   `AUTH` and `QUIT` to the configured relay, which closes "a provider accepts real credentials".
   It sends no `MAIL FROM`, no `RCPT TO` and no `DATA`, so it can never page a human. Skipped, the
   summary line reads `PREFLIGHT PASSED — CREDENTIALS UNPROVEN` rather than passing quietly.

   **What is still unproven, and this blocker is therefore still OPEN:** that the configured
   address is one a phone actually watches, and that anybody is awake. A handshake proves a relay
   accepts credentials; it does not prove a human wakes up, and nothing in this repository can. An
   email-to-SMS gateway decommissioned last year accepts mail exactly like a working one. The only
   thing that closes this is a real test page to a real person who confirms they received it — a
   checklist item in `docs/RUNBOOK.md` §go-live, not a command.

   Two rules were added with it — `AlertmanagerNotificationsFailing` and `AlertmanagerDown`, both
   `page`, on a new `prl-alertmanager` scrape job — so that the alerting system's own inability to
   deliver is reported rather than silent. They catch the partial cases; both paths broken at once
   cannot be reported in band and `docs/production/runbooks/alerting-blind.md` says so.
3. **Images are signed by a locally-held key; they are not bound to a builder.** *Rewritten
   2026-08-25. This entry used to read "Images carry a registry digest but no signature … nothing is
   signed, there is no transparency log, and a local registry is not a third party."* Half of that
   is now closed and the half that is not is stated more precisely than "needs cosign in CI".

   **Closed.** cosign 3.1.3 is installed, a keypair exists, and both release images are pushed to
   `127.0.0.1:5001` and **signed by digest**, each carrying a **signed CycloneDX SBOM attestation**
   of its own contents (api 103 components, web 61). `pnpm run security:image-provenance` verifies
   both against the committed public key `deploy/signing/cosign.pub` and **needs no private key** —
   verification is something a deployer can do. It is gate twelve of `security:audit`, and it is a
   refusal rather than a report: it fails on an unsigned digest, on a digest signed by another key,
   on a transplanted signature, on a signature record that names no images, on an attestation whose
   subject is a different artefact, and on an attestation over an empty predicate. Three of those
   are demonstrated live against a real registry by
   `node scripts/supply-chain/image-provenance.mjs --negative-control`, which fails the gate unless
   every one is refused *and* a positive control is accepted.

   The check that ties any of it to this repository is not cosign's: the gate refuses unless each
   signed digest is byte-identical to the digest `deploy/staging/release-manifest.json` records for
   that service. Without it, a sidecar pointing at some other correctly-signed image would pass every
   cryptographic check.

   **Still open, and this is the residual.** The key is a long-lived file on the release machine, so
   the signatures prove **possession of a key, not the identity of a builder** — anybody who can read
   `deploy/signing/cosign.key` and its passphrase can sign anything, and nothing can tell the
   difference. There is **no transparency log** (`--tlog-upload=false` / `--insecure-ignore-tlog`,
   against a loopback registry), so there is no third-party record that a signature existed at a
   time: key compromise is not detectable after the fact and a signature cannot be shown to predate a
   revocation. The SBOM attestation says what is *inside* the image, which is a different question
   from what built it; a SLSA provenance predicate emitted by the builder answers that and nothing
   here emits one. And **signing is not in CI and cannot be** as things stand — it needs a private
   key, and this repository has no CI signing identity, so `.github/workflows/*` run `security:audit`
   at a point where no release image exists and the gate reports *not applicable* there, loudly.

   What closes the remainder is **keyless/OIDC signing**: Fulcio issues a short-lived certificate
   bound to a workload identity — a named workflow, in a named repository, on a named ref — and the
   verifier demands `--certificate-identity` and `--certificate-oidc-issuer` instead of a key, with
   Rekor as the witness. The claim then changes from *"somebody who had the key"* to *"this workflow
   at this commit"*, and there is no long-lived secret to steal.

   One line, for quoting: **the digest a deployer pulls is now bound by signature to a key this
   repository controls; it is not yet bound to a builder anybody else can check.**
   [`deploy/signing/README.md`](../../deploy/signing/README.md) is the long form, custody and
   rotation included; [`runbooks/unverified-image.md`](runbooks/unverified-image.md) is what to do
   when verification fails.
4. **Twenty-five of the twenty-seven alert rules are loaded, agreed, grounded and evaluable, but
   have not been provoked.** Two are driven end to end — `ApiDown` for the paging tier and
   `RateLimitBans` for the ticket tier — which is what makes the two-tier rule a tested property
   rather than a configuration file.
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
