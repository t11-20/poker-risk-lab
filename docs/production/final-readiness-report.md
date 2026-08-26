# Final readiness report

**Candidate SHA:** `0b01f90ce510759ccc253692a11b179787e9e0db`
**Tree at freeze:** clean — the release manifest records `dirty: false`.
**Branch:** `production-hardening-2`
**Date:** 2026-08-26
**Host:** Darwin arm64, Node v24.18.0, pnpm 11.10.0

> ## Re-frozen 2026-08-26 at `b5bbdd734169`
>
> The previous header had been advanced without re-measuring anything under it, and this banner
> records why that happened rather than quietly deleting the evidence. `scripts/readiness-report.mjs`'s
> join covered **three fields** — the candidate SHA and the two digests — so those three stayed
> honest while every measurement around them rotted, and the document read as freshly stamped
> *because* the stamped parts were the guarded ones. At its worst it described a candidate 13,004
> inserted lines and 132 files behind its own header. **A partial join manufactures confidence**,
> which is worse than no join at all.
>
> The join now covers the alert-rule inventory, the drill count, the supply-chain gate count and its
> ordinals, and the accessibility split, each demonstrated failing when the document drifts. Every
> figure below was measured on this host at this SHA, and the commands are named beside them.

> ## Rebuilt for a HIGH CVE, then signed and deployed — **closed 2026-08-27**
>
> `security:audit` blocked the release: **CVE-2026-14456**, HIGH, in libcrypto3/libssl3 3.5.7-r0 —
> the OpenSSL shipped by the pinned `node:24.18.0-alpine3.24` digest. Four findings across both
> images, 0 unfixable, in the exact digests staging was running. A fresh upstream advisory against
> artefacts built hours earlier, not a regression in this tree. It was caught by the container CVE
> gate on a routine `verify`, with nobody reading an advisory feed.
>
> `Dockerfile.api` and `Dockerfile.web` install the fixed 3.5.8-r0 from alpine/v3.24/main, pinned
> exactly, in `base` so every derived stage carries it. **No CVE was allowlisted; the allowlist is
> empty.**
>
> **Done, in `go-live.md`'s order — sign at §2.3, deploy at §3:**
>
> | Step | Result |
> | --- | --- |
> | `release:artifacts` at `0b01f90ce510` | both images rebuilt from a clean tree, `dirty: false` |
> | `security:containers` | **api 0, web 0** at or above HIGH; 0 unfixable, 0 allowed |
> | `release:sign` | both published to the promotion registry, **signed by digest**, each with a CycloneDX 1.7 SBOM attestation (api 103 components, web 61); registry digest equals the build digest for both |
> | `security:image-provenance` | exit 0, posture **KEY** |
> | `security:audit` | **15 of 15 pass**, `release-image-signatures` among them |
> | `staging up` | migrations applied, **71-check strict smoke over TLS**, X-Forwarded-For overwrite confirmed against 24 forged client addresses, `staging-verified.json` written |
> | `staging status` | all four services running/healthy, **api and web both match the manifest** |
> | `security:containers` against the **deployed** digests | **0 blocking** |
>
> Signing before deploying is the order that matters: the reverse would put staging on digests
> nothing had signed and leave `security:audit` red across the whole rehearsal — the window in which
> somebody decides the gate is noise. An earlier version of this banner had it backwards.
>
> Every staging-derived measurement below the fold was taken against the SUPERSEDED pair and is
> marked as such where it appears. The strict smoke has been re-run against the new pair and passed;
> the alert verification and the reliability drills have **not** been re-taken.
>
> ## Re-measured 2026-08-26 at `7e861ae0a9f1`
>
> Read this before any number in this document. `pnpm run verify` was run again on this host at
> commit `7e861ae0a9f1`, which is **behind the candidate SHA** now recorded in the
> header, and the gate results in "Gates from this SHA" are from THAT run. The images the header
> names were built from `375303fa9714` and predate every one of those commits. **A release from
> this document requires `pnpm run release:artifacts` at the new commit and a full re-freeze**; the
> candidate SHA and the digests have deliberately NOT been advanced, because advancing a header over
> measurements taken elsewhere is the exact mistake the banner below records.
>
> What changed, and why the counts here moved: `verify` gained a fifteenth gate, `test:layout`, and
> the release pipeline gained the nine `verify` gates it had never run. The measured result at
> `7e861ae0a9f1`: **`pnpm run verify` passes 15 of the 15 that existed then, 3,586 tests, 0
> failures**.
>
> **`verify` is sixteen gates today, and the closing run of 2026-08-27 was at `cb1fcca`:
> 15 of 16 PASS, 3,694 tests, 0 test failures.** The single red is `security:audit` →
> `release-image-signatures`, the expected-red described at the top of this document, which clears
> at go-live step 2.3. Every other gate passed, and `security:audit`'s own fifteen were 14 pass / 1
> fail — that one. (An earlier run at `27014bb2`, the commit that wired `test:keyboard` in, was
> 15 of 16 with 3,643 tests; the difference is the guards added after it.) `test:keyboard` — real keyboard journeys in real Chrome — was added on 2026-08-26. It
> was not a new check: it existed, it was thorough, and it ran NOWHERE, because it had no `--start`
> and so needed a person to bring up a web server and an API by hand first. Measured on its own at
> that commit: **146 checks, 0 failures**, over six consecutive runs, 56-59s each.
>
> The count in this document was itself unguarded until now. `readiness-report.test.mjs` checked
> every "N gates" claim against the supply-chain count, which was safe only by accident — `verify`
> ran fourteen and `security:audit` runs fourteen — so the sweep agreed with both and could not tell
> them apart. `test:layout` made them fifteen and fourteen and the sweep failed on a correct
> document. Each claim is now attributed to the list it is about by its nearest preceding marker,
> and a claim naming neither list is refused rather than guessed at.

This candidate supersedes `b292b2ac234c`. That one was frozen with two open blockers and a
disagreement between two reviews; reconciling the disagreement found defects neither review had,
and an adversarial audit of the whole repository found more. Everything below is measured against
this SHA unless a line says otherwise.

---

## Verdict

**PRODUCTION HARDENING COMPLETE — EXTERNAL ACCESSIBILITY CERTIFICATION REQUIRED**

`pnpm run verify` exits **0**: at this candidate it was all fourteen of the gates that existed
then, with **3,555 tests passing**, and at `7e861ae0a9f1` — the re-measurement in the banner above —
all fifteen of the gates that existed by then and **3,586 tests, zero failures**,
including a supply-chain audit which ran fourteen of its gates then. `security:audit` is
**fifteen gates** since `pinned-action-advisories` joined it on 2026-08-27, which is later than
every measurement in this document. Release image signature verification,
container log policy and the keyless-signing identity gate were all added on 2026-08-25 and all
measured passing here. The container
scan reports **zero** findings at or above HIGH on either image. Staging runs these digests with a
71-check strict smoke over TLS; both alerting tiers are verified end to end over both transports;
sixteen reliability drills pass; backup/restore including a real scratch restore passes; and a
rollback to the previous digest pair and back was rehearsed.

Two things are true here that were not true of any previous capture. Every alert rule's series is
grounded against a **live scrape of this image** rather than against the working tree — the previous
run failed that check, correctly, because the room-ownership series existed in the code and not in
the deployed container. And a release can no longer be **promoted** with paging that goes nowhere:
`alerts:preflight` refuses placeholder, malformed, credential-less and unrouted destinations, and it
refuses staging's own configuration today, which is the gate working rather than failing.

Screen-reader certification remains **UNVERIFIED**: `osascript` answers `-1743` on this host and no
grant this repository can make will change that. It needs a person with VoiceOver or NVDA. That is
the one thing standing between this and a PASS string, and it is not a code defect.

What has changed is its size. **70 of the certification's 72 assertions are now machine-verified on
every run** of `pnpm run test:ax`, one check per assertion ID, against the rendered accessibility
tree in real Chrome — so a regression in any of them fails `pnpm run verify` on the day it lands.
Nineteen of those were with the person until the gate grew the three fixtures they needed: a **live
table over a real socket**, a **hand it played, replayed at `/review/<handId>`**, and a **second web
app with no API behind it**. Three more moved on 2026-08-26 — 2.4, 2.9 and 3.19 — each because the
reason it had been left turned out to be answerable: see residual 1. **4 still require a person
listening**, and three of the four are genuinely about the reader rather than about this repository;
the fourth, 4.2, is a defect the certification is holding rather than a limit of it. The session is
now roughly **five minutes per platform** rather than the better part of an afternoon. The blocker
is not reduced; the work behind it is.

Two of the rows that moved were not certification limits at all. **3.3** recorded that "A new hand
was dealt." never reaches the DOM and asked a reviewer to judge whether hearing the blinds instead
was a PASS; that was an application defect filed as a checklist item, and it is fixed — the table's
narration region is now mounted before a hand is dealt, and the deal is carried onto the front of
the forced-bets sentence so the reader hears "A new hand was dealt. smallBlind 5 from seat 3,
bigBlind 10 from seat 4" as one polite announcement. **1.5** asked a reviewer to check a disclosure
`/learn` has never had, and is retired. Both are recorded in section 5 of the certification.

---

## What changed since `b292b2ac234c`

### 2026-08-25, after this candidate was first frozen

**The system could not tell a paying student from a free one.** No enrolment record, no entitlement,
no receipt — established by exhaustive search, and the last product-level gap between this and taking
money. `db/migrations/0006` adds `prl.cohorts` and `prl.enrolments`; `pnpm run enrolments` grants
them; `PRL_ENROLMENT_REQUIRED=enforced` gates **taking a seat** and nothing else.

Three decisions in that worth stating, because each was a fork:

- **The record, not the till.** There are no amounts, no currency and no processor anywhere in the
  schema, and there is no payment path in this repository at all. A scholarship cohort and a paid one
  produce identical rows, because the grant happens out of band and the `reference` column is an
  opaque string that may literally read `scholarship`. This is why `/terms` §7 can no longer say the
  service is free **and** must not say it is paid: the software cannot tell.
- **Grants are an operator CLI, not an HTTP admin API.** There is no admin role in this system and no
  privilege surface above a learner. Adding one for a class of thirty, at the end of a hardening run,
  is a large new attack surface bought for very little. `prl_app` — the request-path role — holds
  **SELECT only** on both tables: the API can ask who is entitled and cannot enrol, extend or
  un-revoke anybody.
- **One choke point, not one guard per route.** There are three ways to reach a seat and the restart
  retake path is a fourth that calls `table.sit` directly. The guard is on the seat, so a fifth route
  arrives gated. A learner no longer entitled does not get their chair back after a restart, and a
  failed entitlement read leaves the seat unrestored.

The switch ships **off** — an open instance is a legitimate deployment — but staging runs it
`enforced` and the strict smoke drives all four cells over TLS against the deployed image, refusing
and then accepting *the same `sit` frame* with only an enrolment row between them. A default-off flag
nobody has watched refuse anything is decoration.


Seven defects found and closed after the freeze, each with a negative control demonstrated against
the old code rather than asserted. They are listed first because a reader who stops after one
section should read these.

- **`replicas: 1` was a correctness constraint enforced by nothing.** Two API processes serving one
  room deal two different hands, and whichever settlement lands second overwrites the other's chips
  with no error anywhere. An operator scaling for capacity, *any* rolling deploy where the new
  container serves before the old one drains, or two developers pointing local APIs at one database
  all did it silently. It is now a lease in Postgres (`db/migrations/0005`): a second process is
  refused, and a process that loses its lease evicts the room instead of continuing to deal. The
  lease is taken **before** `reconcileInterruptedHands`, because reconciling first would settle the
  hand rows of a room another process is mid-hand in — the guard would have caused the damage it
  exists to prevent. See [ADR 0013](../adr/0013-room-affinity-and-horizontal-scale.md) for why
  horizontal scale is a protocol change and not a proxy setting.
- **The reverse proxy logged OAuth authorization codes in the clear.** Both shipped nginx configs
  used the stock `combined` format, which writes `"$request"` verbatim — so `code` and `state` from
  every OIDC callback landed on disk, one hop upstream of the API's own redaction, along with raw
  client addresses and full user agents the API only ever stores as digests. Proven with a sentinel
  before and after, in a throwaway container and then against the running staging proxy. The error
  log needed its own fix: `ngx_http_log_error` stamps the full request line at any level and no
  `log_format` touches it, so the level is the only lever.
- **Half a cohort met a 429 on their first interaction.** Sign-in is address-keyed — correctly, since
  a route that issues a session cannot be keyed by that session — but sized for a public instance.
  Measured: 30 learners on one campus address, `completed=15 refused=15`, first refusal at learner
  16. The ceiling is now cohort-sized and the anti-abuse job moved to a budget on *failed* outcomes,
  because a start from a student and a start from a script are identical on arrival and differ only
  in how they end. Forced token-endpoint exchanges — the expensive path — are unchanged at 15,
  measured both ways.
- **A retention promise was documented in five places and implemented in none.** Abandoned guest
  accounts were kept forever, with an index built for the reaper and a `DELETE` grant widened for it.
  The period is derived rather than chosen: sixty days unseen is the smallest window after which
  every credential that could reach a guest account is already dead.
- **Paging could be promoted broken.** `alerts:verify` structurally cannot catch an unconfigured
  destination — it renders the destinations it then asserts against, so it passes *hardest* when
  nothing is set. `alerts:preflight` now refuses, and `staging promote` refuses with it.
  Alertmanager's own delivery failures are scraped, ruled and runbooked: the one failure no in-band
  alert can report.
- **Release images were unsigned.** Both are now signed by digest with an attested CycloneDX SBOM,
  verifiable from the committed public key alone, with unsigned, wrong-key and transplanted-signature
  cases all demonstrated being refused.
- **Two records of the same fact had nothing joining them.** This report stated image digests that
  were never this candidate's, and survived a green fourteen-gate run because every gate read the
  manifest's JSON and none read the report's prose. `scripts/readiness-report.test.mjs` is the join,
  and it earned its place immediately: it is what failed when this candidate was built, because the
  report still named the previous one.


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
| `pnpm run verify` | **every gate passed, exit 0** — all 15 of the gates that existed then; **3,586 tests, 0 failures**. Measured at `7e861ae0a9f1`, not at the candidate SHA — see the banner at the top. `verify` is **sixteen gates** since `test:keyboard` was added on 2026-08-26, and this row predates it | `verify-rules.log` |
| `pnpm run security:audit` | **every gate passed** — all 14 of the gates that existed then; `release-image-signatures`, `log policy` and `keyless-signing-identity` had all been added on 2026-08-25. `security:audit` is **fifteen gates** since `pinned-action-advisories` was added on 2026-08-27, and this row predates it | inside `verify-6.log` |
| API tests | **994 / 994** | inside `verify-13.log` |
| Script tests | **1,165 / 1,165** | inside `verify-13.log` |
| Package + web tests | engine 134, contracts 21, maths 256, ui 265, content 29, AI 156, web 358 | — |
| `test:exhaustive` | all 133,784,560 seven-card hands | inside `verify-final.log` |
| `test:simulation` | 23 / 23, every profile within its declared traits | inside `verify-final.log` |
| Container CVE scan | **0 blocking, 0 unfixable, 0 allowed** at floor HIGH, both images on alpine 3.24.1 | `scan-final.log` |
| `release:sign` | both images pushed, signed and attested by digest; registry digest **equals** build digest for both | — |
| `security:image-provenance` | **exit 0** — both digests verify against the committed public key; SBOM attestations verify with subjects matching (api 103 components, web 61) | — |
| `--negative-control` | **three refusals, one acceptance**: unsigned digest → cosign exit 10 `no signatures found`; wrong key → exit 1 `accepted signatures do not match threshold, Found: 0, Expected 1`; transplanted signature → exit 1 `provided artifact digest does not match any digest in statement`; positive control accepted | — |
| `security:secrets` | pass — working tree and all history blobs | — |
| `release:artifacts` | `ARTIFACTS_EXIT=0`, manifest `dirty: false` | `artifacts.log` |
| `staging up` | `STAGING_EXIT=0`, **62-check strict smoke**, digests matched, XFF overwritten 24/24, HSTS single-sourced | `staging.log` |
| `alerts:verify` | **33 of 33, exit 0** — re-run after the dead man's switch landed. BOTH tiers provoked end to end: `ApiDown` (page) reached firing 244s after the API stopped, was delivered on `/page`, was emailed over a real SMTP transaction, resolved 19s after recovery and did **not** raise a ticket; `RateLimitBans` (ticket) was provoked by driving the limiter past its ban threshold (`{"ok":300,"refused":400}`), was delivered on `/ticket` and over SMTP, and did **not** page | `alerts-final.log` |
| `alerts:verify`, grounding | **35 rules — 16 page, 18 ticket, 1 heartbeat** — all loaded, all agreeing with `alerts.md`, every runbook on disk, every expression evaluating, and every series they name present in a **live scrape** of this candidate's image: 44 metric families from the API, plus `up{job="prl-alertmanager"} = 1` and `alertmanager_notifications_failed_total` among 109. The room-ownership, retention-sweep and Alertmanager series are grounded here for the first time — the previous capture failed this check because they existed in the tree and not in the deployed image, which is the check working | `alerts-final.log` |
| `alerts:preflight` | **REFUSES the staging configuration, exit 1**, and that is correct: staging's paging destinations are `alerts:verify`'s own throwaway `.invalid` sinks. The seven structural checks pass — 6 destinations parsed, both tiers distinct, TLS to every off-host destination, 35 rules over 3 severities all resolving to receivers that have somewhere to send. `staging promote` will not call a release promotable while this fails | — |
| Proxy log leak, **live** | A sentinel request to `/api/v1/auth/oidc/callback?code=…&state=…` against the **running** staging proxy: **0** occurrences in the access log and **0** in the error log. What it logged instead: `"GET /api/v1/auth/oidc/callback?" 501 rt=0.031 up=172.20.0.3:3001 rid=ee14e2aa-…` — path without query, address truncated to `/24`, agent classed, the API's own request id joined | — |
| `staging up` | **exit 0** — migrations applied, **71-check** strict smoke over TLS, both running containers confirmed to be the manifest digests, all four healthy | `staging-3.log` |
| `test:ax`, certification assertions | **65 of 65** at this candidate SHA, **68 of 68** since 2.4, 2.9 and 3.19 moved on 2026-08-26, and **70 of 70** since 4.2 and 7.4 were fixed in the product on the same day (see residual 1) — the machine-checkable share of the 72 manual assertions, one check per assertion ID, in Chrome 151, now including a hand played over a real socket at `/play`, replayed at `/review/<handId>`, and a second web app with no API behind it. Demonstrated to refuse, three times over: seven components broken in an earlier pass (footer landmark name, route-announcer politeness, `<main tabIndex>`, action-button `aria-label`, face-down card naming, sheet focus return, quiz `aria-describedby` order) failed **10** checks by ID; five broken for the live-table and replay fixtures (the stack dropped from the turn sentence, the decision echo prefixed onto every announcement, `role="alert"` removed from the table-unavailable block, the replay's end-of-hand focus rescue deleted, a face-down card renamed "card") failed exactly **3.5, 3.17, 3.20, 6.5 and 6.6** and nothing else; and for the two rows that moved in this pass, restoring the deal-announcement defect failed **3.3** alone with the two writes it recorded quoted back, pointing the offline web app at the live API failed **8.2** as "the web server reached an API after all", and hiding the fallback notice's sentence behind `aria-hidden` failed **8.2** as a visual-only badge. For 4.2 and 7.4, a build with the count taken back out of the Lab's title and the `inert` sweep removed from `MobileNav` failed exactly **J4.2** ("a count that is not in the title is a count no reader is told") and **J7.4** ("90 of 188 elements behind the sheet are still non-ignored") and nothing else; a second build that re-dressed the summary as a live region and exempted the footer from the sweep failed the same two rows on their other clauses. All passed again on restore | see residual 1 |
| Screen reader, the residual **7** at this SHA, **2** since | **UNVERIFIED** `-1743`. Needs a person listening; about five minutes per platform | — |

**The three `alerts:*` rows above are a capture and are left as captured.** They read 26 checks, 28
rules and 2 severities, which is what this candidate's run reported and what its logs hold. The dead
man's switch and the front-door probe take those to 35 rules over 3 severities and add checks 7-9 — see
residual 2 below, which carries the measurements from that run rather than restating them here.
Editing a stamped row to match a later tree is how a capture stops being evidence.

### Images

**This table was wrong, and it is kept with the correction rather than quietly replaced.** It read:

| Service | Digest ~~(as published)~~ — **NOT this candidate's** |
| --- | --- |
| api | `sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17` |
| web | `sha256:aa894fcfab4157a8ce5bd864cf9d6aaafa447f4ed70c114cc6cc2ba23bd320a3` |

Those two are the digests the previous push left in the local registry, from candidate
`091d67ac39ce-dirty`, and they were never this candidate's — `deploy/staging/release-manifest.json`
recorded a different pair throughout, and those were what the staging containers were running. Found by hand on 2026-08-25 while signing, by reading the manifest against this table. No
gate could have caught it, because until now nothing consumed both: prose in a report and JSON in a
manifest were two records with nothing joining them. The signature record is the first artefact
that has to reconcile a digest with the manifest's, which is why the drift surfaced here.
**The digests this candidate built, signed and runs are the ones below**, and they are what
`deploy/staging/release-manifest.json` and `deploy/staging/release-signatures.json` both record:

| Service | Digest built, pushed, **signed** and **deployed** | Superseded digest |
| --- | --- | --- |
| api | `sha256:94872a9abc937547b0d98441e4496718a9a5f879b2ea4f6c17a33be48a9d4083` | `sha256:5411626265ada1324ede2544034bfe2699e5106469319e106429c17c34bfb75d` |
| web | `sha256:e1c04b0e4f5f1d940280c09cda74e23981120d9f9fdacb72b3995199b9864af3` | `sha256:6b1043cc9edbdce67870d365f74809199be5cc0b5f905b77747138dce9fa1f5f` |

**The left-hand pair is the live one**: built at `0b01f90ce510`, published to the promotion
registry, signed by digest with a CycloneDX SBOM attestation each, and deployed to staging on
2026-08-27, where `staging status` confirms both services match the manifest and the container scan
reports 0 findings at or above HIGH against those exact digests.

The superseded pair is kept visible rather than deleted because it is the pair **CVE-2026-14456 was
found in**, and deleting the digests a HIGH advisory landed on would erase the only record of what
was affected. It was itself pushed and signed while it was current.

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

1. **Screen-reader certification is UNVERIFIED — 70 of 72 machine-verified, 2 still need a person
   listening.** **This is the only item that keeps this candidate from a PASS string.**

   The reason previously recorded for it — `osascript` error `-1743` — is accurate about what the
   machine said and misleading about what it means. **-1743 refuses an AGENT permission to drive
   VoiceOver; it does not stop a person.** Pressing Command + F5 and listening needs no Automation
   grant. What has been missing is not a permission, it is half an hour of somebody's attention.

   **What is now automated.** Each of the 72 assertions in
   [`accessibility-certification.md`](accessibility-certification.md) carries a `Checked by` marker.
   **70 are marked `auto`** and have a real check in `scripts/ax-assertions.mjs`, run by
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
   | J1 Learn | 5 | 5 | 0 |
   | J2 Guided practice | 9 | 9 | 0 |
   | J3 Table and Coach | 21 | 21 | 0 |
   | J4 Scenario Lab | 6 | 6 | 0 |
   | J5 AI Legends | 5 | 5 | 0 |
   | J6 Hand review | 7 | 6 | 1 |
   | J7 Navigation sheet | 6 | 6 | 0 |
   | J8 Failure paths | 3 | 2 | 1 |
   | **Total** | **72** | **70** | **2** |

   Writing them found four real defects that had sat in the document as untested claims: **G3
   asserts a `contentinfo` landmark named "About Poker Risk Lab" and the footer's computed name was
   the empty string** — a heading inside a landmark does not name the landmark, fixed in
   `apps/web/src/components/SiteFooter.tsx`; **3.2 asserts that a reader who opens the table or
   takes a seat is placed on the status line and hears it, and that landing place had no computed
   name at all** — `role="status"` takes none from its contents — fixed with an `aria-label` in
   `apps/web/src/app/play/LiveTable.tsx`; **the table's polite narration region was not in the
   document at the moment a hand was dealt**, because it was owned by a component that is not
   rendered until a view arrives, so on the first hand of every session it was created already
   holding its first sentence and announced nothing — moved to `TableStage` and mounted
   unconditionally; and **"A new hand was dealt." was never announced**, because it and the forced
   bets are two events of one table notice and two writes into one atomic polite region for one
   notice are one announcement — the deal is now carried onto the front of that sentence and
   written once. The last two are 3.3, which this document had been recording as a limit of the
   certification rather than as a bug.

   **Three of those seven moved on 2026-08-26, and none of them moved because the standard was
   relaxed.** 2.4's "the prompt is not read twice" has exactly one cause inside the accessibility
   tree — a reader announces a group's name on entry, so the prompt is heard twice if and only if it
   is in a second accessible name — and the check asserts the absence of it. 2.9's "no score is
   announced anywhere" is now decided by DIFFERENCE rather than by scanning for the word "score":
   the quiz is walked to its review panel twice from a fresh load, diverging in exactly one answer,
   and the two must read identically, which no wording can escape. 3.19's server refusal was said to
   need "a second actor racing the same seat"; it needs one task — `disabled` arrives from React
   state, so two `click()`s inside one task both reach `act` and both frames leave over one socket.
   Measured against the running server, the second was answered
   `It is not your turn to act. (not_your_turn). Nothing was applied.`, assertively, and it was the
   only interruption in the whole hand.

   **What is still a person's job, and why.** The 2 `person` rows are two states no fixture reaches
   honestly: a failing deck proof, which would need a server that lies about a deal (6.7), and a
   build with a deliberate `throw` in the root layout, which would need an application build inside
   `verify` or a shipped switch whose job is to break the app (8.3). Section 5 of the certification
   lists both with one line each. The classification stays deliberately conservative: a row that
   mixes a checkable fact with a claim about speech stays with the person, because a row
   half-covered by a machine and dropped from the human session is a row nobody checks.

   **Two rows that used to be here were defects, not limits, and were fixed in the product on
   2026-08-26.** Both measurements were re-taken before anything was changed and both held.
   **4.2** — the Scenario Lab's filter is a plain `GET` form, so submitting it replaces the
   document: measured in Chrome 151, the JavaScript context was destroyed, `document.title` was
   byte-identical before and after, and the summary region took **zero mutations** on the new
   document because it arrived already holding "Showing 14 of 36 scenarios." A live region that
   arrives with its text announces nothing, which is the same fact 3.3 was fixed for — and unlike
   3.3 there is no surviving context to write into later. A filtered view now carries the count in
   its title, which is the one channel a full document load announces with no JavaScript, and the
   summary's dead `aria-live` is gone. **7.4** — measured, 29 of 34 content-bearing nodes behind the
   open sheet were still non-ignored in the computed tree, because `MobileNav` held the background
   in scope with `aria-modal="true"` and a focus trap and nothing else. Every subtree that is not
   the sheet is now `inert` while it is open; re-measured after, 0 of 188 are reachable. Both
   checks were shown to fail against a build with the defect restored before either row moved.

   `pnpm run certify:screen-reader` is now the way to spend the five minutes: it presents **the 2**,
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

   Two rules were added with it — `AlertmanagerNotificationsFailing` and `AlertmanagerDown`, both
   `page`, on a new `prl-alertmanager` scrape job — so that the alerting system's own inability to
   deliver is reported rather than silent. They catch the partial cases; both paths broken at once
   cannot be reported in band and `docs/production/runbooks/alerting-blind.md` says so.

   **Added 2026-08-25, and this is the part that moves the boundary rather than describing it.**
   The sentence this entry used to end on was *"a handshake proves a relay accepts credentials; it
   does not prove a human wakes up, and nothing in this repository can."* The first clause is still
   true. The second was too quick, and two things now stand against it.

   *A dead man's switch.* `Watchdog` (`expr: vector(1)`, `severity: heartbeat`) fires permanently
   and is routed to a **third** receiver — neither the pager nor the ticket queue — whose
   destination is `PRL_ALERT_HEARTBEAT_WEBHOOK_URL`, a snitch outside this deployment. Its
   *silence* is the alarm, which makes it the only report here that does not travel the channel
   that broke. `alerts:verify` check 7 proves the whole emitting half against the running overlay,
   and the run below is **33 of 33 checks, exit 0**: the rule fires; **17 pings** arrive on the
   heartbeat path with measured gaps of 20–25 s against a 60 s deadline (20 s repeat rounded up to
   the next 5 s flush, which is why `group_interval` is deliberately not equal to
   `repeat_interval`); **not one** of them reaches a human tier over either transport; and then —
   with Alertmanager deliberately **stopped**, a container that script created and removes, never
   a staging one — the absence is detected: *"silent for 60 s, past the 60 s deadline, after 17
   ping(s). Prometheus still reports 2 alert(s) firing and delivered 0 webhook(s) and 0 email(s)
   of any kind in that window."* The pings resumed 44 s after the restart, and the induced silence
   is in the JSON artefact as a single number among the gaps: `104673`.

   That one line is the incident `alerting-blind.md` opens with, reproduced on demand — the rules
   perfect, the evaluation perfect, the deployment blind, and one signal leaving by a door that did
   not depend on the thing that failed. The check has been **observed failing** too: with the
   heartbeat routed to a path the watcher does not read, the run reports *"nothing named Watchdog
   has arrived on /heartbeat"*, *"no heartbeat has ever arrived"* and exits 1. That negative
   control found a real defect in its first outing — the silence check went green over a heartbeat
   that had never arrived at all, a detection of nothing — and it now refuses that case by name.

   `alerts:preflight` refuses to promote a heartbeat URL that is a placeholder, names this
   machine, equals either human destination, or is plaintext (a snitch's ping URL is its
   credential) — so the emitting half cannot ship without a watcher named. **The watcher itself is
   irreducibly external**: one on this host would die with the host it is watching.

   *An acknowledged test page.* `pnpm run alerts:ack` posts a real `severity: page` alert to this
   deployment's Alertmanager, so it travels the real route tree to the real receiver, carrying a
   one-time code in an alert **label** — which puts it in the `Subject:` a locked screen shows.
   The command then refuses to exit 0 until a person types that code back inside `--within` and
   inside five attempts.

   This paragraph used to end *"there is no path to the code that does not go through the pager."*
   **That was false and an adversarial review demonstrated it**: the code is echoed back by
   Alertmanager's own unauthenticated `GET /api/v2/alerts`, `--alertmanager` is a caller-supplied
   URL, and the subject was printed on the command's own stdout six lines above a promise that it
   was not. A robot read it off the screen and passed; another read it out of an Alertmanager it
   controlled and passed with `attended: true`. There is no construction that keeps a secret from
   its own caller, so the claim was **changed rather than patched**. What a pass now asserts, and
   all it asserts: somebody was at a terminal, inside the window and inside five attempts, holding
   a code this run generated and sent as a page through the named Alertmanager. That is evidence a
   **cooperating** operator produces for themselves, not an attestation against a hostile one, and
   the command's own closing paragraph and a `caveat` field in its record both say so.

   What was fixed rather than re-described: the code is no longer printed on the passing path
   (subjects render `(······ page)`), attempts are capped at five — measured at 106,450 guesses per
   second through a real pty against a 30-bit space — and `rehearsal` is now derived from the
   targeted Alertmanager's own config and from observing the page arrive, not from environment
   variables. An all-defaults run that the old code announced as *"pages NOBODY"* relayed to
   `smtp.sendgrid.example:587`; it is now refused. **Demonstrated failing** with
   a real terminal and nobody at it: `ACK FAILED — nobody acknowledged inside the window`, exit 1,
   after the page had verifiably been delivered — `[FIRING:1] OperatorTestPage (······ page)`
   captured at the SMTP sink, with the code in the subject a locked screen shows. The mechanism
   was separately rehearsed end to end against the repository's own `.invalid` sinks, which
   reports `ACK REHEARSED — the mechanism works. NO PERSON WAS INVOLVED.` and stamps the record
   `attended: false`: unattended acknowledgement is refused outright the moment a real destination
   is configured, so it can never manufacture a green record against a real pager.

   **This blocker is still OPEN, and here is exactly how far it has narrowed.** It used to be the
   whole of "no human is paged". What remains is one thing and it is a fact about the future rather
   than about this deployment: an acknowledgement records that **somebody acknowledged one page, at
   a known time, within a bounded window** — it is not a promise about 3am next Tuesday, the
   holiday nobody put in the rota, or the gateway decommissioned three months from now. Closing it
   needs a person on a real device (`alerts:ack`, exit 0, with this environment's `PRL_ALERT_*`
   set) and a snitch somebody else runs (`PRL_ALERT_HEARTBEAT_WEBHOOK_URL`, armed, grace period at
   least three intervals). Both are checklist items in `docs/RUNBOOK.md` §11.7, the pre-deployment
   checklist — there is no §go-live in that file. What changed is
   that each of those checkboxes now has a command behind it that produces a dated artefact and
   fails loudly when it cannot — where before, both were an instruction to remember something.
3. **Images are signed by a locally-held key; they are not bound to a builder.** *Rewritten
   2026-08-25. This entry used to read "Images carry a registry digest but no signature … nothing is
   signed, there is no transparency log, and a local registry is not a third party."* Half of that
   is now closed and the half that is not is stated more precisely than "needs cosign in CI".

   **Closed.** cosign 3.1.3 is installed, a keypair exists, and both release images are pushed to
   `127.0.0.1:5001` and **signed by digest**, each carrying a **signed CycloneDX SBOM attestation**
   of its own contents (api 103 components, web 61). `pnpm run security:image-provenance` verifies
   both against the committed public key `deploy/signing/cosign.pub` and **needs no private key** —
   verification is something a deployer can do. It is gate fifteen of `security:audit` — the last
   in the `GATES` array, corrected 2026-08-26 from "twelve" and again 2026-08-27 when
   `pinned-action-advisories` was inserted ahead of it — and it is a
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

   **Still open, and this is the residual.** Every release image in this repository is signed by a
   long-lived key on the release machine, so those signatures prove **possession of a key, not the
   identity of a builder** — anybody who can read `deploy/signing/cosign.key` and its passphrase can
   sign anything, and nothing can tell the difference. There is **no transparency log** behind them
   (`--tlog-upload=false` / `--insecure-ignore-tlog`, against a loopback registry), so there is no
   third-party record that a signature existed at a time: key compromise is not detectable after the
   fact and a signature cannot be shown to predate a revocation.

   **The previous version of this paragraph said signing "is not in CI and cannot be". That was
   wrong, and it is worth recording why**, because it is the shape of a whole class of wrong
   statement: it treated a missing *configuration* as a missing *capability*. Keyless signing needs
   no CI signing identity to be created — a GitHub Actions job with `id-token: write` already has
   one, Fulcio will exchange it for a ten-minute certificate bound to the workflow, and Rekor
   witnesses the exchange. Nothing had to be invented. What did not exist was the workflow, the
   verification policy, and the gate that holds the two together.

   **What now exists, and is checked on every push:**

   * [`.github/workflows/release-sign.yml`](../../.github/workflows/release-sign.yml) — follows a
     successful `Release` run, pushes the built images to GHCR and signs them keylessly. It grants
     `id-token: write` **to the `sign` job alone and never at the workflow top level**, because a
     top-level grant is inherited by every job in the file. `ci.yml` and `release.yml` still declare
     `permissions: contents: read` and grant no `id-token` anywhere.
   * [`deploy/signing/keyless-policy.json`](../../deploy/signing/keyless-policy.json) — the committed
     identity policy: the exact certificate SAN and the exact OIDC issuer a keyless signature must
     carry. Exact strings, never a regexp; Rekor required.
   * `pnpm run security:image-provenance` verifies **whichever posture an image is actually in**, and
     refuses a signature record that is in neither — an unsigned release is exactly what "neither"
     looks like, so "absent" is never read as "the other posture, presumably".
   * `pnpm run security:keyless` — gate 8 of the fifteen in `security:audit`, hermetic — fails if
     the policy and the workflow stop agreeing: a rename, a trigger that can run on another ref,
     `id-token: write` at the top level or in a second job or in **any** other workflow, a wildcard
     in the ref, or an issuer that is not GitHub's. Demonstrated failing, live, for the tag-trigger
     case, the top-level-grant case and the rename case.
   * Four keyless refusals are demonstrated offline by
     `node scripts/supply-chain/image-provenance.mjs --negative-control`, against a certificate
     minted by a throwaway CA: another owner, another workflow file, another issuer, and no identity
     asserted at all. This matters because **a keyless signature verifies against *some* Fulcio
     certificate, and Fulcio issues one to anybody's GitHub Actions job** — the identity assertion is
     not a refinement of keyless verification, it *is* keyless verification.

   **What is still NOT true, and this is the part not to skip.** No run of that workflow has
   happened. **There is no Fulcio certificate and no Rekor entry for this repository**, every release
   image today is in the key posture, and the keyless half is therefore **implemented and
   unexercised** — the machinery is tested, the mechanism is not. Two things cannot be tested here at
   all and are not claimed: the OIDC exchange with Fulcio, and the transparency-log entry. The
   policy also carries `"repository": null`, because this repository has **no git remote** and no
   committed file knows its GitHub owner; the owner half of the identity is therefore unpinned until
   somebody commits it, the gate warns about that on every run, and it refuses outright if a keyless
   signature record is ever committed while it is null. And a SLSA provenance predicate emitted by
   the builder — what went *into* the image, as opposed to who signed it — still does not exist.

   **What the first CI run will produce**: a Fulcio certificate whose SAN is
   `https://github.com/<owner>/poker-risk-lab/.github/workflows/release-sign.yml@refs/heads/main`,
   issued by `https://token.actions.githubusercontent.com`; a Rekor entry for it; and signed images
   in GHCR. **What an outsider could then check that they cannot check today**: that the image they
   pulled was signed by that specific workflow — with `cosign verify --certificate-identity …
   --certificate-oidc-issuer …`, needing nothing from this repository, no key and no trust in its
   maintainers — and, from the public log, that the certificate existed when it says it did. Today an
   outsider can check only that a digest was signed by a key whose public half this repository
   publishes, which is a statement they must already trust the repository to find meaningful.

   One line, for quoting: **the digest a deployer pulls is bound by signature to a key this
   repository controls; the machinery to bind it to a builder anybody else can check is written,
   gated and tested offline, and has never been run.**
   [`deploy/signing/README.md`](../../deploy/signing/README.md) is the long form, custody, rotation
   and the keyless policy included; [`runbooks/unverified-image.md`](runbooks/unverified-image.md) is
   what to do when verification fails.
4. **32 of the 35 alert rules are loaded, agreed, grounded and evaluable, but
   have not been provoked.** (Corrected 2026-08-26: this read "Twenty-six of the twenty-nine" and
   was written when the file held 29. `deploy/staging/observability/alert-rules.yml` holds **35 —
   16 page, 18 ticket, 1 heartbeat**; `node scripts/alert-preflight.mjs` prints the same count.
   `scripts/readiness-report.test.mjs` now joins this sentence to that file.) Three are driven end to end — `ApiDown` for the paging tier,
   `RateLimitBans` for the ticket tier, and `Watchdog` for the heartbeat — which is what makes the
   two-tier rule, and the third destination beside it, tested properties rather than configuration.
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
