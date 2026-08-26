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

`verify` is fifteen gates and `security:audit` inside it is fourteen. The two counts are over
unrelated lists; read each off its own.

## 2. The artefacts (machine, ~10 min)

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
| 4.1 | `pnpm run alerts:verify` | 33 of 33. **Stops the API for ~4 minutes** — do this before students arrive |
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
| 5.1 | `pnpm run test:ax` | 114 checks, 0 failed — 68 of the 72 certification assertions |
| 5.2 **PERSON** | `pnpm run certify:screen-reader` | the remaining **4**, with VoiceOver or NVDA, ~5 min |

The 4 are: what a virtual cursor does past the end of a modal (7.4 — measured, 29 content-bearing
nodes behind the open sheet are still in the computed tree, because the sheet holds the background
in scope with `aria-modal` rather than `inert`, so reachability is the reader's own behaviour); plus
three states no honest fixture reaches — a failing deck proof, which would need a server that lies
about a deal (6.7); the root-layout boundary, which would need a deliberately broken build (8.3);
and the Scenario Lab's filter count (4.2).

**4.2 is a defect, not a limit, and a reviewer will record SILENT against it.** The filter is a plain
`GET` form, so submitting it replaces the document; measured in Chrome 151, the summary region takes
zero mutations on the new page — it arrives already holding "Showing 14 of 36 scenarios.", and a
live region that arrives with its text announces nothing. Nothing else says the count either: the
title is identical before and after. Closing it is a product change — the count in the document
title of a filtered view is the zero-JavaScript fix, and `ScenarioFilters` ships no JavaScript on
purpose — so it is listed here rather than automated away.

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
