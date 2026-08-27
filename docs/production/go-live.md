# Go-live: everything that must be true before a student pays

This is the one ordered list. Everything else in `docs/production/` explains *why* a step exists;
this says what to run, what a pass looks like, and who has to be in the room.

Steps are ordered so that a failure costs the least possible rework. The machine checks come first
because they are free and repeatable. The human steps come last because they cost somebody's
attention and cannot be re-run cheaply.

**The four items marked PERSON cannot be closed by running anything.** They are not gaps in the
engineering; they are the parts of "ready to charge for this" that are, irreducibly, somebody's
judgement or somebody's account. A deployment that skips them is not ready, however green the
gates are.

---

## 1. The code (machine, ~25 min)

| Step | Command | Pass looks like |
| --- | --- | --- |
| 1.1 | `git status --porcelain` | empty — a release is built from a committed tree |
| 1.2 | `pnpm run verify` | `=== verify: every gate passed ===`, exit 0 |
| 1.3 | `pnpm run db:verify` | `every documented schema security property holds` |

`verify` is sixteen gates and `security:audit` inside it is fifteen. The two counts are over
unrelated lists; read each off its own.

## 2. The artefacts (machine, ~10 min)

> **Where this checkout is right now, 2026-08-26.** Steps 2.1 and 2.2 are **already done** at
> `0b01f90ce510` and their evidence is in `final-readiness-report.md`: both images rebuilt from a
> clean tree, and `security:containers` reporting `0 blocking, 0 unfixable, 0 allowed`. They were
> rebuilt because **CVE-2026-14456** (HIGH, OpenSSL) landed upstream in the base image's
> libcrypto3/libssl3 3.5.7-r0; both Dockerfiles now install the fixed 3.5.8-r0, pinned exactly.
>
> **Start at 2.3.** The rebuild invalidated the committed signature record, which still covers the
> superseded digests, so `pnpm run verify` exits non-zero today on `security:audit` →
> `release-image-signatures`. Every other gate passes. That red is expected and it clears at 2.3 —
> it is not a reason to skip it, and it is not a reason to allowlist anything. Nothing was
> allowlisted; the allowlist is empty.
>
> Then 2.4, then §3. **Do not deploy before signing**: staging would run digests nothing had
> signed, and `security:audit` would stay red through the smoke test, the alert verification and
> the drills — which is the window in which somebody decides the gate is noise.

| Step | Command | Pass looks like |
| --- | --- | --- |
| 2.1 | `pnpm run release:artifacts` | manifest records `dirty: false` and this commit's SHA |
| 2.2 | `pnpm run security:containers` | `0 blocking, 0 unfixable, 0 allowed` |
| 2.3 | `pnpm run release:sign` | both images signed and SBOM-attested by digest |
| 2.4 | `pnpm run security:image-provenance` | exit 0, and it names the posture (`KEY` or `KEYLESS`) |

If the release was built by CI rather than a workstation, 2.4 must report **KEYLESS** and the
identity in `deploy/signing/keyless-policy.json` must be the workflow that actually built it.

CI signs **tag pushes only**. `release-sign.yml` requires the triggering run to have been a `push`
— `release.yml`'s only push trigger is `tags: v*` — and to have produced `release-promotable.json`,
which its `promote` job writes and a dry run does not. A `workflow_dispatch` rehearsal therefore
produces no signature at all, which is the intended outcome and not a fault to chase: until this
changed, such a rehearsal against any branch had its images pushed to GHCR and signed under this
repository's identity, because a dry run concludes *success*. If a release needs signing, tag it.
`"repository": null` in that file means nobody has set the GitHub owner yet — it warns on every run
and fails outright if a keyless record is committed while it is null.

## 3. The deployment (machine, ~10 min)

| Step | Command | Pass looks like |
| --- | --- | --- |
| 3.1 | `pnpm run staging up` | migrations applied, strict smoke passes, all containers healthy |
| 3.2 | `pnpm run test:drills` | every reliability drill passes |
| 3.3 | `pnpm run backup create` then `backup verify --deep` | a real scratch restore, then dropped |

## 4. Alerting (machine, then PERSON)

| Step | Command | Pass looks like |
| --- | --- | --- |
| 4.1 | `pnpm run alerts:verify` | 35 of 35 (it was 33 before the heartbeat checks grew; read the count off the run). **Stops the API for ~4 minutes** — do this before students arrive |
| 4.2 | `pnpm run alerts:preflight` | exit 0 with *this* environment's `PRL_ALERT_*` set |
| 4.3 | `pnpm run alerts:preflight -- --handshake` | must **not** say `CREDENTIALS UNPROVEN` |
| 4.4 **PERSON** | `pnpm run alerts:ack -- --by <name> --out ack.json` | a real page arrives and **a human types the code back** |

4.2 refuses the shipped defaults on purpose: staging's paging destinations are throwaway `.invalid`
sinks, which is what lets `alerts:verify` drive both tiers without waking anybody.

**PERSON — the external snitch.** `PRL_ALERT_HEARTBEAT_WEBHOOK_URL` must name a dead-man's-switch
service somebody else runs, with a grace period of at least three `PRL_ALERT_HEARTBEAT_INTERVAL`s.
A snitch on this host dies with the host it is watching, so this one cannot be satisfied locally at
all. Preflight refuses a placeholder, so the emitter cannot ship alone — but whether that snitch is
armed and attached to a phone is a fact about an account this repository does not hold.

## 5. Accessibility

| Step | Command | Pass looks like |
| --- | --- | --- |
| 5.1 | `pnpm run test:ax` | 116 checks, 0 failed — **70 of the 72** certification assertions |
| 5.2 **PERSON** | `pnpm run certify:screen-reader` | the remaining **2**, with VoiceOver or NVDA, ~3 min |

**The 2 are both "no honest fixture reaches this state", not "a machine cannot judge it":** a
failing deck proof, which would need a server that lies about a deal (6.7), and the root-layout
error boundary, which would need a deliberately broken build (8.3). SSR-rendering the fallback would
check the fallback's tree without checking that the boundary is wired, which reads as covered twice
and is covered zero times. 6.7 is reachable with a pass-through proxy that flips one byte inside a
real reveal — costed in `accessibility-certification.md` §5, and not taken, because it puts a third
server and a proxy inside a release gate for one row.

**Two rows that used to be here were product defects, and were fixed rather than certified around**
(2026-08-26). 4.2: the Scenario Lab's filter count was announced to nobody — the `GET` form replaces
the document, and the summary region arrived already holding its text, which announces nothing. The
count is now in the `<title>` of a filtered view, which a document load announces, with no
JavaScript. 7.4: the background behind the mobile sheet was held with `aria-modal`, a request to the
reader, so reachability was the reader's behaviour; every non-sheet subtree is now `inert`, and 0 of
188 content-bearing elements behind an open sheet remain in the computed tree.

`test:ax` starts a **second** web app of its own on `:3459` with no API behind it, for assertion
8.2. It is torn down with the rest; if that port is taken, pass `--offline-url`.

## 6. The cohort

| Step | Command | Pass looks like |
| --- | --- | --- |
| 6.1 | students sign in **once** | an enrolment names an account; somebody who has never signed in has neither a `usr_` id nor an OIDC subject |
| 6.2 | `pnpm run enrolments cohort-create …` | the cohort exists with the right start and end |
| 6.3 | `pnpm run enrolments grant … --dry-run` | every identifier resolves; **it refuses the whole batch if any does not** |
| 6.4 | `pnpm run enrolments grant …` | one transaction; rows and audit entries land together |
| 6.5 | `PRL_ENROLMENT_REQUIRED=enforced`, roll the API | unenrolled learners are refused a seat and can still read everything else |

Order matters: grants first, switch second. Reversed, every learner is turned away until the grants
land — nothing is lost, but the first morning of a course is the wrong time to find out.

## 7. The parts no command can do

- **PERSON — counsel.** `docs/production/legal-register.md` holds the decisions: what (if anything)
  was sold and what must be disclosed before it; refunds and cooling-off; what deleting an account
  should do to a live entitlement, which today the `ON DELETE CASCADE` destroys. Every engineering
  dependency the register named is closed; none of the decisions are engineering's to make.
  **The deletion question narrowed on 2026-08-26** and counsel should be given the narrower one: a
  cascade writes no audit row, so a live place used to end with nothing saying so and the operator's
  trail showed an entitlement that was never closed. `deleteAccount` now writes an
  `enrolment.ended_by_erasure` row per enrolment, before the rows go, detached, carrying the cohort,
  the authority, the external reference and whether the place was still live. So the question is no
  longer "can a destroyed entitlement be evidenced at all" — it can, on both sides — but what the
  operator owes the holder of a live place who erases themselves.
- **PERSON — a git remote, which is what turns `KEY` into `KEYLESS`.** This repository has none, so
  every release is signed with the long-lived key on the release machine. That proves possession of
  a key and **not** the identity of a builder: `security:image-provenance` says `KEY` and
  `deploy/signing/README.md` says what that is worth. Push to a remote and let
  `.github/workflows/release-sign.yml` run once on a `v*` tag, and the signature carries a Fulcio
  certificate naming the workflow instead. Until then `deploy/signing/keyless-policy.json` has
  `"repository": null`, which warns on every run and fails outright if a keyless record is
  committed while it is null. Nothing about this blocks a deployment; it bounds what an outsider
  can check about one.
- **PERSON — the screen-reader session** (5.2).
- **PERSON — the acknowledged page** (4.4), and the external snitch behind it.
- **PERSON — someone on call.** An acknowledgement records that somebody answered one page at a
  known time. It says nothing about 3am next Tuesday, about the holiday nobody put in the rota, or
  about the gateway decommissioned in three months.

## Known ceilings, not defects

- **One API process serves every room.** `replicas: 1` is correctness, not sizing — enforced by a
  lease since `db/migrations/0005`, not merely documented. Horizontal scale is a protocol change
  ([ADR 0013](../adr/0013-room-affinity-and-horizontal-scale.md)), so no configuration serves
  hundreds of concurrent *seated* players. Vertical scale is available and buys exactly the
  resources that run out first.
- **Nothing here takes money.** There is no processor, no checkout and no column that could hold an
  amount. Enrolment records who holds a place and on whose authority; whatever took the payment is
  somebody else's system, and the `reference` column is the only link back to it.
