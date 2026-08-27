# Counsel pack — the eleven decisions, in the order they should be answered

**Status:** Launch blocker, OPEN · **This document closes nothing and answers nothing** ·
**Assembled:** 2026-08-27 · **Branch:** `production-hardening-2` ·
**Page text under review:** `0.2-draft` (`apps/web/src/lib/legal-config.ts:84`)

**This is a derived working document.** The register is
[`legal-review-requirements.md`](legal-review-requirements.md) — that file is mechanically coupled to
the product (`apps/web/test/legal-pages.test.ts:178-193` fails the build if a clause is marked on a
page and missing from it, or listed there and missing from the page it claims) and it is the
authoritative list. Nothing here may be read as replacing, narrowing or reordering it. The facts
under each decision come from [`legal-register.md`](legal-register.md); every one of them was re-read
out of the working tree on 2026-08-27 and is cited to file and line, and **§4 below lists the ones
that had gone stale and what they say now.**

**What this document is for.** The register is written for completeness. This is written for one
sitting: each entry states a decision that can be answered, the facts the answer turns on with a
place to check each, what changes in the product for each plausible answer, and where the product is
currently holding a gap open waiting for it.

**Nothing in this document is legal advice, and no entry may be closed by an engineer.** It contains
no draft clause text, deliberately: text that reads like approved terms is the one artefact this
process exists to keep out of the repository. The wording is counsel's; this supplies the facts.

---

## 0. Five minutes on the product

**What it is.** An educational, play-money No-Limit Hold'em lab — probability, expected value,
variance and risk. A learner reads lessons, answers quiz questions, plays decisions in a scenario
lab, and plays hands at private tables against bots. Chips are called *units*: free, resettable at
will, and valueless. `packages/ui/src/format.ts:180-198` will not render a bare number without the
word "units"; `packages/content/test/scenarios.test.ts:311-326` fails the build on "real money",
"cash out", "withdraw", "deposit", a currency symbol, or a daily-bonus framing.

**What it does with money: nothing, and that is enforced rather than asserted.**

| Claim | Where it is established |
|---|---|
| No balance, currency, price, purchase, payout, prize or transfer column exists anywhere in the schema, and no table that could be a ledger of value | `db/migrations/0001_initial.sql:4-9` |
| The enrolment migration adds no amount, currency, processor, receipt or refund arithmetic either | `db/migrations/0006_cohort_enrolments.sql:25-30` |
| No payment dependency, no checkout route, no money-shaped table name — checked over `apps/web/src`, `apps/api/src` and every `packages/*/src` on every build | `apps/web/test/legal-pages.test.ts:870-874` (money words), `:954-960` (the source roots), `:1131-1164` (the migration sweep) |
| The application's only outbound connection is to an OIDC identity provider, if one is configured | `apps/api/src/auth/oidc.ts:892,901`; the web app's three `fetch` sites are all same-origin (`apps/web/src/lib/api.ts:397`, `apps/web/src/lib/guest-bootstrap.ts:251,271`) |
| No analytics, error reporting, CDN, remote font or advertising — not disabled, absent; the content-security policy has no host for any of them | `apps/web/src/lib/csp.ts:79,136` |

One thing to hear from us rather than find: `prl.hand_actions` has a column called `amount_paid`
(`db/migrations/0001_initial.sql:715-716`). It is a count of practice units committed by a seat in a
hand — the same kind of number as `pot_after` beside it — and `prl.hand_seats.net_result` is
commented "A count of practice units, not a balance" (`:679`). Neither is money and neither can
become money: nothing converts a unit into anything, no endpoint transfers a unit between accounts,
and the reset is unconditional and never penalised (`apps/api/src/routes/auth.ts:1110-1115`).

**What `/terms` says about it now.** §7 ("What access to this costs, and what the software records
about it") and §8 ("Availability") are the two clauses that carry the commercial question
(`apps/web/src/app/terms/page.tsx:289`, `:319`). §7 used to read *"This service is provided free of
charge…"*, and every promise §8 withheld was withheld on that footing. That sentence was removed on
2026-08-25 — not replaced with its opposite, which would have asserted a fee this software cannot
establish. §7 now states what an enrolment record holds and says outright that **an enrolment record
is not evidence that money changed hands**; §8 keeps the technical availability facts and says
outright that they do not settle whether the operator may exercise them without owing the reader
something. Both carry a marker and both are decisions below.

**What a "place in a cohort" technically is.** Since `db/migrations/0006_cohort_enrolments.sql` the
schema has two tables:

* **`prl.cohorts`** (`:215-243`) — an identified class: an operator-facing key, a display name,
  a start and an optional end. It has no account column and none that could hold one; its own table
  comment says it "holds nothing about any person and nothing about what anything cost" (`:245-247`).
* **`prl.enrolments`** (`:262-322`) — one person's place in one cohort: the cohort
  (`ON DELETE RESTRICT`, `:266-267`), the account (`ON DELETE CASCADE`, `:269-270`), when it was
  granted, `granted_by` as free text naming **the authority the grant rests on** (`:277-281`),
  `reference` as an **opaque external string** (`:285-289`), a start, an optional expiry, and a
  revocation triple that a `CHECK` refuses unless it is wholly present or wholly absent (`:294-321`).

Three properties of that record decide most of what counsel is asked below.

1. **It records that somebody *is* entitled and *who said so* — never what anything cost.** The
   `reference` is never parsed here. It may be a purchase-order number, a row id in a finance system
   nobody here can read, a registry entry, or **the literal word `scholarship`** (`:32-37`,
   `:333-335`). A scholarship cohort, an employer-funded class and a paid course produce identical
   rows. **Wherever a question below is premised on a fee, counsel must answer for the free case
   too, because the code cannot distinguish them.**
2. **Entitlement is the intersection of two periods** — the enrolment's and the cohort's (`:83-99`).
   A cohort that has ended entitles nobody, however its enrolments are written.
3. **There is no privileged HTTP surface.** The request-path role holds `SELECT` and nothing else on
   both tables (`:387-388`) — the narrowest verb set in the schema. Grants and revocations are an
   operator command connecting as the migrating identity, unreachable from any request handler
   (`apps/api/scripts/enrolments.mjs:81,651`; the reasoning at `db/migrations/0006_cohort_enrolments.sql:143-162`).
   An injection reaching the request path can read who is enrolled and cannot enrol, extend or
   un-revoke anybody.

**The record can now gate one thing** — added in `5e2753a` on 2026-08-25, the same day the migration
landed and after the register's entry for it was written, which is why the register does not
mention it. `PRL_ENROLMENT_REQUIRED` is `off` by default; set to
`enforced`, a live enrolment becomes a condition of **taking a seat at a table** and nothing else
— lessons, the scenario lab and the glossary stay open. The check sits at one choke point rather
than on the routes, because there are three ways to reach a seat
(`apps/api/src/rooms/entitlement.ts:1-42`, `apps/api/src/rooms/registry.ts:1322-1327`,
`apps/api/src/config.ts:827-833`). `go-live.md` §6.5 makes switching it on the last step of cohort
onboarding. **The register still says nothing is gated on entitlement; that is the largest of the
corrections in §4.**

**One structural cost that applies to every entry below, so it is stated once.** Replacing a marked
paragraph with counsel's wording is a **three-part change that cannot be done in parts**: the prose
in the page, the clause's removal from `COUNSEL_CLAUSES` (`apps/web/src/lib/legal-config.ts:163-320`),
and the entry in [`legal-review-requirements.md`](legal-review-requirements.md).
`apps/web/test/legal-pages.test.ts:140-193` fails on any one of the three done alone — deleting the
register entry without replacing the prose leaves a page with a gap, and deleting the prose without
the entry leaves a lawyer's list with a phantom on it. `LEGAL_REVISION`
(`apps/web/src/lib/legal-config.ts:84`) moves in the same change, because `/terms` §12 promises a
reader that the revision changes when the text does and that string is the whole of the notification
mechanism this product has.

**A numbering hazard, before anything is cited back.** Two documents number these decisions and
**the numbers are not the same**. `legal-review-requirements.md` numbers 1–11; `legal-register.md`
numbers L1–L13, and its L4–L8 are a different permutation of the same five subjects (its L4 is the
review document's entry 6, its L7 is entry 4, its L8 is entry 5). The **clause id** — `governing-law`,
`enrolment-and-fees` — is the same in both, in the page source, and in the code. **An answer that
cites a slug cannot be filed against the wrong question; an answer that cites a bare number can.**
Every entry below carries all three.

---

## 1. Reading order

All eleven are launch blockers and the register is right to say so. They are not equally urgent, and
"launch blocker" does not sequence them. What follows sorts them by **what an unanswered entry
prevents**, not by how much a wrong answer would cost.

### The three that block taking money

**Nothing about the tier is a claim that these matter most.** `play-money-classification` (C1) has
the widest blast radius of any entry in this document. These three are first because a deployment
that has answered every other entry and not these three still cannot charge anybody.

| # | Clause id | Review entry | Register | Why it blocks a charge |
|---|---|---|---|---|
| **A1** | `enrolment-and-fees` | 10 | L10 | What has been sold, and what must be disclosed before it is sold. Unanswered, there is no answer to "what did the student buy" |
| **A2** | `refunds-and-cancellation` | 11 | L11 | Cancellation and cooling-off rights are typically **pre-contract** disclosures. Unanswered, a purchase cannot lawfully be completed in several regimes |
| **A3** | `operator-identity` | 1 | L1 | The pages currently render "not supplied by this deployment" where the seller's identity goes. A sale by a party that does not identify itself makes every other clause harder to enforce and every contact obligation unmet |

### The four that block launch once money is involved

| # | Clause id | Review entry | Register | What is unanswered |
|---|---|---|---|---|
| **B1** | `liability-and-warranty` | 5 | L8 | What may be disclaimed and limited. Its free-of-charge premise was **withdrawn rather than answered** |
| **B2** | `governing-law` | 4 | L7 | Law, forum, and whether the choice survives a consumer resident elsewhere |
| **B3** | `data-controller-and-rights` | 6 | L4 | Controller, lawful basis, and which statutory rights must be offered — **access and portability do not exist as a product feature** |
| **B4** | `retention-and-deletion` | 7 | L5 | The periods, and whether erasure must delete hand history rather than detach it |

### The four that block launch whether or not anybody is charged

| # | Clause id | Review entry | Register | What is unanswered |
|---|---|---|---|---|
| **C1** | `play-money-classification` | 3 | L3 | Whether this is a regulated product anywhere it is offered. **Highest blast radius in the pack** — `docs/THREAT-MODEL.md:17-22` rests several security severity ratings on the absence of financial motive |
| **C2** | `age-threshold` | 2 | L2 | Whether a minimum age is required, what it is, and whether an unverified self-declaration is enough |
| **C3** | `international-transfer` | 8 | L6 | Where the database and backups sit, who administers them, what that requires |
| **C4** | `ai-legend-naming` | 9 | L9 | Whether attributed opponent names may be displayed. **Already fenced by a safe default**, so it blocks a feature rather than the launch |

---

## 2. The decisions

Each entry: **the decision**, phrased to be answerable · **facts, each with somewhere to check it** ·
**what changes for each answer, and what it costs** · **where the product is currently holding the
gap open.**

Cost labels used throughout:

* **Recorded** — nothing in the product changes; the answer is written down and the marker is
  replaced with counsel's wording.
* **Page wording** — prose replaces a marked paragraph. See the three-part coupling in §0.
* **Configuration** — one or more `PRL_*` values and a redeploy. No build, no image.
* **Code** — new routes or logic.
* **Migration** — a schema change. Roll-forward only: `apps/api/scripts/migrate.mjs` records a
  sha256 of every applied file and aborts on a mismatch, so an applied migration cannot be edited,
  **including a comment in it**. Usually also a change to the least-privilege grants.

---

### A1 · `enrolment-and-fees` — what an enrolment is, and what the operator has sold

**Blocks:** taking money · **Review entry 10 · register L10** ·
**Flagged on** `/terms` §7 (`apps/web/src/app/terms/page.tsx:315`, under the heading at `:289`).

#### The decision

1. **What, if anything, has the operator sold** when it grants a place in a cohort — access to
   teaching material, a course of instruction, something else, or nothing (a grant)?
2. **Which contract terms and pre-contract disclosures must be presented before that sale, on which
   page, and by whom** — given that the purchase, where there is one, completes in a system this
   software cannot see?
3. **Do terms displayed on `/terms` bind a purchase completed elsewhere?** Yes / no / only if
   presented in some named way.
4. **Does the answer to (2) differ for a cohort enrolled for nothing** — a scholarship, an employer,
   a class of friends? The record is byte-identical.
5. **Must acceptance of terms be recorded?** Yes / no. (There is no column that could hold it, and no
   consent mechanism anywhere in this product.)

#### Facts counsel can rely on

| Fact | Where to check it |
|---|---|
| This software still cannot take money — no processor, no checkout route, no amount, currency or price column, in this migration or anywhere in the schema | `db/migrations/0006_cohort_enrolments.sql:25-30`; `db/migrations/0001_initial.sql:4-9` |
| A test fails the build on a money-shaped dependency, table name or source file, **in either posture the page can be in**, and money words fail unconditionally | `apps/web/test/legal-pages.test.ts:870-874,1131-1164,1191-1215` |
| An enrolment records **that** somebody is entitled and **who said so**; the `reference` is opaque and may be the word `scholarship` | `db/migrations/0006_cohort_enrolments.sql:32-37,285-289,333-335` |
| `granted_by` is free text and deliberately not a foreign key: there is no instructor table and **no admin role in this product** | `db/migrations/0006_cohort_enrolments.sql:277-281,330-332` |
| Entitlement is the intersection of the enrolment's window and the cohort's; a cohort that has ended entitles nobody | `db/migrations/0006_cohort_enrolments.sql:83-99` |
| The request path holds `SELECT` and nothing else on both tables; grants are an operator CLI connecting as the migrating identity | `db/migrations/0006_cohort_enrolments.sql:387-388,143-162`; `apps/api/scripts/enrolments.mjs:81,147,651` |
| **Access can now be gated on entitlement.** `PRL_ENROLMENT_REQUIRED=enforced` makes a live enrolment a condition of taking a seat, and of nothing else — lessons, the lab and the glossary stay open | `apps/api/src/config.ts:827-833`; `apps/api/src/rooms/entitlement.ts:13-32`; `apps/api/src/rooms/registry.ts:1312-1327`; `docs/production/go-live.md:181` |
| A refusal deliberately does not say **why** somebody is not entitled — never enrolled, revoked, expired and not-yet-started are one answer | `apps/api/src/rooms/entitlement.ts:56-67` |
| The default is `off`, and every deployment that exists today is ungated | `.env.example:371`; `apps/api/src/rooms/entitlement.ts:15-18` |
| Every account is created automatically for any visitor, so an enrolled reader and an unenrolled one are the same kind of account, differing only by the presence of a row | `apps/web/src/app/privacy/page.tsx:305-320` |
| **Acceptance of terms is not recorded anywhere**, and no column could hold it | schema: `db/migrations/` — no table has an acceptance, consent or agreement column |
| A grant, a supersession and a revocation each write an append-only audit row in the same transaction, and a grant's detail carries the external `reference` | `apps/api/src/repositories/enrolments.ts:523,535-547,590` |

#### What changes per answer

| Answer | What changes | Cost |
|---|---|---|
| Fee is collected entirely off-platform; access stays ungated | `/terms` §7's factual half already fits. Counsel's wording replaces the marked paragraph | **Page wording** |
| Fee off-platform; access must be gated on entitlement | Nothing new is built — the check exists and the read is indexed for a request path (`db/migrations/0006_cohort_enrolments.sql:358-373`). Set `PRL_ENROLMENT_REQUIRED=enforced` and decide what an unenrolled reader is shown | **Configuration**, plus page wording |
| Gating must cover more than a seat (lessons, the lab) | A second decision the choke point does not make. New refusals on new surfaces, and a decision about the prospective-student browsing surface | **Code** |
| Pre-contract disclosures must appear on a page this application serves | A new page, reachable without an account like the other three — and it must be on the age gate's always-open list (`apps/web/src/lib/age-gate.ts:154-160`) or it is unreadable behind a gate | **Code** |
| Acceptance must be recorded | A new column or table, a new `/privacy` inventory entry, a new retention period, and a `/privacy` inventory test that will fail until the page accounts for it | **Migration** |
| Nothing has been sold (grants only) | Answer is recorded; §7's factual half stands | **Recorded** + page wording |

---

### A2 · `refunds-and-cancellation` — refunds, cancellation, and what an interruption costs the reader

**Blocks:** taking money · **Review entry 11 · register L11** ·
**Flagged on** `/terms` §8 (`apps/web/src/app/terms/page.tsx:340`, under the heading at `:319`).

#### The decision

1. **What refund, cancellation or cooling-off right must be offered** where a place was paid for?
2. **Does a cooling-off right survive the student starting the course?** Yes / no / partially.
3. **Must the policy be shown before purchase, and where** — given the purchase completes off this
   platform?
4. **What does the operator owe a reader whose access ends because the deployment was taken down,
   reset or changed** — which `/terms` §8 states as a technical fact about how the thing is built?
5. **What should deleting an account do to a place in a course that has not expired?** Today it
   destroys it. Keep / preserve / void-with-a-record / something else.

#### Facts counsel can rely on

| Fact | Where to check it |
|---|---|
| There is no refund concept at any layer — no amount, no order, no receipt, nothing that could record money going back. Revoking an enrolment ends access and returns nothing | `db/migrations/0006_cohort_enrolments.sql:25-30`. **Checked rather than asserted:** the word "refund" occurs in application source only as this clause's own id and question text (`apps/web/src/lib/legal-config.ts:133,246-256`, `apps/web/src/app/terms/page.tsx:45,340`) and in one rate-limiter comment about token buckets (`apps/api/src/routes/auth.ts:151`). No implementation, no column, no route. The register's "appears nowhere in the application" is looser than the code supports |
| Revocation is a **record, not an erasure**: `revoked_at`, `revoked_by` and `revoked_reason` are written into the row and the row stays. A `CHECK` refuses a partial revocation, so a withdrawal with no stated reason cannot be recorded at all | `db/migrations/0006_cohort_enrolments.sql:294-321,339-342` |
| A re-grant after a revocation works: the uniqueness index is partial on `revoked_at IS NULL` | `db/migrations/0006_cohort_enrolments.sql:354-356` |
| **Deleting an account destroys the enrolment.** `user_id` is `ON DELETE CASCADE`, so `POST /me/delete` removes every place the reader held, live or revoked | `db/migrations/0006_cohort_enrolments.sql:269-270`, argued at `:168-193`; `apps/api/src/routes/auth.ts:1166-1173` |
| **It is now recorded when that happens.** A cascade is a referential action and writes no audit row, so until 2026-08-26 a live place ended with nothing saying so and the operator's trail over-counted for ever — precisely for the readers who exercised erasure. `deleteAccount` now writes one `enrolment.ended_by_erasure` row per enrolment, in the same transaction and **before** the rows go, detached from the start, carrying the cohort, the authority, the external `reference` and **whether the place was still live** | `apps/api/src/repositories/users.ts:516-547` |
| That row is a **distinct event** from `enrolment.revoked`, because it is a different act: a revocation names an operator who withdrew a place; this is an entitlement ending on nobody's authority | `apps/api/src/repositories/users.ts:500-511` |
| Those audit rows survive the erasure detached (`audit_log.user_id` is `SET NULL`) and **nothing ever removes them** — so the external `reference` an operator typed outlives the person it was typed about | `db/migrations/0001_initial.sql:855-856`; `docs/production/legal-register.md` §2.12 |
| Nothing in this software can be told that a refund happened, so any refund policy is enforced by an operator running a revocation by hand | `apps/api/scripts/enrolments.mjs:81` — `revoke` is a CLI verb and nothing else |
| `/terms` §8 no longer disclaims availability on the basis of being free, and says outright that the technical facts do not settle what the operator owes | `apps/web/src/app/terms/page.tsx:319-341` |

**The question narrowed on 2026-08-26 and counsel should be given the narrower one.** It is no longer
"can a destroyed entitlement be evidenced at all" — it can, on both sides. It is: **what does the
operator owe the holder of a live place who erases themselves**, given that the record of it now
exists and names nobody.

#### What changes per answer

| Answer | What changes | Cost |
|---|---|---|
| Statutory cooling-off applies | The policy must be presented before purchase, which is off this platform, and §8's wording must be reconciled with it | **Page wording**, plus an operator obligation outside the code |
| A refund revokes access | The mechanism exists (`enrolments revoke`). What does not exist is any link between a refund event and this system — the link is an operator procedure | **Recorded** + runbook |
| Deletion must **not** destroy an unexpired entitlement | A change to `0006`'s referential action and to `deleteAccount`, **and** a decision about what an entitlement naming nobody would mean. `accountFootprint` counts `prl.enrolments` and throws if anything survives an erasure, so this cannot be done by half | **Migration** + code (`apps/api/src/repositories/users.ts:376-388,580`) |
| Deletion may destroy it, but the ending must be evidenced | **Already done** — `enrolment.ended_by_erasure`, `apps/api/src/repositories/users.ts:516-547`. Answer is recorded | **Recorded** |
| Nothing further is owed on a takedown or reset | §8's technical half stands; counsel's wording replaces the marked paragraph | **Page wording** |

---

### A3 · `operator-identity` — who operates this deployment

**Blocks:** taking money · **Review entry 1 · register L1** ·
**Flagged on** `/terms` §2 (`apps/web/src/app/terms/page.tsx:193`) **and** `/privacy` §7
(`apps/web/src/app/privacy/page.tsx:538`).

#### The decision

1. **Which legal entity operates this instance, and in which country is it established?**
2. **What identification and contact details must appear on these pages** for that entity, in each
   place it serves readers?
3. **Where the operator also grants places in cohorts: must it identify itself as the seller as
   well, and does that change (2)?**

#### Facts counsel can rely on

| Fact | Where to check it |
|---|---|
| The software is published under the MIT licence and can be run by anyone, and **one image serves every deployer** — the operator name is read from the server environment at request time rather than inlined at build | `LICENSE:1-3`; `apps/web/src/lib/legal-config.ts:45-52` |
| The pages render `PRL_LEGAL_OPERATOR` and `PRL_LEGAL_CONTACT` from the **server environment at request time**, never a build-time constant — `NEXT_PUBLIC_*` is banned in this repository for exactly this reason | `apps/web/src/lib/legal-config.ts:45-52,415-416` |
| Unset renders a visible "not supplied by this deployment" marker, never a plausible-looking default | `apps/web/src/lib/legal-config.ts:19-21,456` |
| Both are unset today: commented placeholders | `.env.example:553-554` |
| Operator-supplied strings are stripped of C0/C1 controls, zero-width characters and bidi overrides before rendering, and truncated at 160 characters — a company name that reorders the sentence around it is a real way for a legal page to say something it does not say | `apps/web/src/lib/legal-config.ts:355-388,405` |
| `PRL_LEGAL_EFFECTIVE_DATE` is validated for shape **and** reality (`2026-02-31` matches the pattern and is not a date); a malformed value is ignored and reported on the page | `apps/web/src/lib/legal-config.ts:423-431` |
| While any of operator, contact, governing law, hosting region or effective date is missing, all three pages carry a "not ready to be relied on" notice | `apps/web/src/lib/legal-config.ts:351,445-451` |

#### What changes per answer

| Answer | What changes | Cost |
|---|---|---|
| A named entity and a contact line | Two environment variables and a redeploy | **Configuration** |
| A registered number, address or tax identifier is also required | Either more variables or a rewritten `prl-legal__meta` definition list on `/terms` and `/privacy` | **Configuration** or **code** |
| The details must differ per jurisdiction served | Nothing in this product varies a page by reader location, and adding it is not a variable | **Code** |

---

### B1 · `liability-and-warranty` — warranty disclaimer and limitation of liability

**Blocks:** launch, once money is involved · **Review entry 5 · register L8** ·
**Flagged on** `/terms` §9, Liability (`apps/web/src/app/terms/page.tsx:349`, heading at `:344`).

**Read this first.** The premise this entry carried — *"and that the software is offered free of
charge"* — was **withdrawn rather than answered** on 2026-08-25. It was true when written and stopped
being something this software can establish the moment the schema grew a record of who holds a place
in a course. It was not replaced with its opposite, which would have asserted a fee. The reasoning is
recorded beside the question at `apps/web/src/lib/legal-config.ts:206-219`. **Counsel must answer for
a deployment that charges and one that does not, because the code cannot distinguish them.**

#### The decision

1. **What may this deployment lawfully disclaim** by way of warranty, for a paid cohort and for a
   free one?
2. **What may it lawfully limit or cap**, given that parts of a broad exclusion are unenforceable
   against consumers in several jurisdictions?
3. **May the availability and data-survival disclaimer in §8 stand as against somebody who paid?**
   (This is the seam with A2 — §8 says outright that it does not settle this.)

#### Facts counsel can rely on

| Fact | Where to check it |
|---|---|
| The shipped text says only that the software is provided as it is and the authors make no warranty. **No cap, no exclusion list, no indemnity** | `apps/web/src/app/terms/page.tsx:344-350` |
| The clause a lawyer replaces is **one paragraph and one marker**, both in §9 | `apps/web/src/app/terms/page.tsx:344-350` |
| §8 (Availability) is a different clause carrying a different marker — `refunds-and-cancellation`, A2 above. The register recorded this as "§8" until 2026-08-26 | `apps/web/src/app/terms/page.tsx:319-341` |
| `LICENSE` covers the software; it does not cover the service a deployer offers | `LICENSE`; `apps/web/src/app/terms/page.tsx:346-348` |
| The availability facts §8 states are descriptions of how the thing is built, not terms somebody chose: one process is authoritative for a table at a time (`replicas: 1` is correctness, not sizing — ADR 0001, ADR 0013), there is no undo, and the only copies of a reader's rows are the operator's backups | `apps/web/src/app/terms/page.tsx:321-328`; `db/migrations/0005_room_ownership.sql` |

#### What changes per answer

| Answer | What changes | Cost |
|---|---|---|
| Any answer at all | Prose replaces the §9 paragraph; the clause leaves `COUNSEL_CLAUSES`; the register entry closes | **Page wording** |
| The disclaimer must differ for paid and unpaid readers | **This software cannot tell them apart.** Either the page states both cases, or something must record which a reader is — which is A1's acceptance question and a migration | **Page wording**, or **migration** if it must be conditional |

---

### B2 · `governing-law` — governing law and where a dispute is heard

**Blocks:** launch, once money is involved · **Review entry 4 · register L7** ·
**Flagged on** `/terms` §11 (`apps/web/src/app/terms/page.tsx:363`, heading at `:362`).

#### The decision

1. **Which law governs these terms?**
2. **Which forum hears a dispute?**
3. **Does that choice survive against a consumer resident elsewhere**, and if not, what must the page
   say instead?

#### Facts counsel can rely on

| Fact | Where to check it |
|---|---|
| The governing law shown in the page header comes from `PRL_LEGAL_GOVERNING_LAW` and nothing else | `apps/web/src/lib/legal-config.ts:417`; rendered by `readLegalDeployment` at `:410-412` |
| **There is no arbitration clause, no class-action waiver and no forum selection anywhere in the shipped text** — writing one would be the conclusion this process exists to refuse. §11 is a heading and the marker, with no prose at all between them | `apps/web/src/app/terms/page.tsx:361-364` |
| The variable is unset; the page shows the gap marker | `.env.example:555` |
| A student who was charged is a consumer with a contract, so this stops being theoretical the moment A1 is answered in the "something was sold" direction | — |

#### What changes per answer

| Answer | What changes | Cost |
|---|---|---|
| A named law, and the clause stands as a bare statement | One environment variable, plus prose replacing the marker | **Configuration** + page wording |
| A forum or dispute-resolution term is required | Prose that does not exist today anywhere in this product | **Page wording** |
| The choice does not survive for some readers | Whatever the page must say instead. Nothing here varies by reader location | **Page wording**, or **code** if it must vary |

---

### B3 · `data-controller-and-rights` — controller, lawful basis, and which rights apply

**Blocks:** launch, once money is involved · **Review entry 6 · register L4** ·
**Flagged on** `/privacy` §2, the inventory (`apps/web/src/app/privacy/page.tsx:334`, heading at `:321`).

#### The decision

1. **Who is the controller** of each category in the `/privacy` §2 inventory?
2. **On what lawful basis is each category processed?**
3. **Which statutory rights — access, rectification, erasure, portability, objection — must be
   offered, and to which readers?**
4. **Does granting a place in a cohort change the basis for any category** from whatever it is today?

#### Facts counsel can rely on

| Fact | Where to check it |
|---|---|
| `/privacy` §2 is a table-by-table inventory taken from the schema and the repositories. It is a description of fact and it is **checked**: a migration that adds a table `/privacy` does not account for fails the build. It has fired three times — `prl.room_ownership`, then `prl.cohorts` and `prl.enrolments` | `apps/web/test/legal-pages.test.ts:422-440` |
| **Re-checked 2026-08-27:** `db/migrations/0007_audit_forbidden_keys.sql` landed after the register was written and **creates no table**, so the inventory is still complete | `db/migrations/0007_audit_forbidden_keys.sql` (no `CREATE TABLE`) |
| An account row holds a display name and **no email, no password and no date of birth** — not blank columns: no such columns exist | `db/migrations/0001_initial.sql:229-258` |
| An account is created for a visitor **automatically**, on opening a lesson, without being asked for anything | `apps/web/src/app/privacy/page.tsx:305-320` |
| Sessions store a SHA-256 of the token — the token itself is never stored, so reading the table cannot sign anyone in — plus optional **keyed** HMACs of the IP address and user agent, never the raw values | `db/migrations/0001_initial.sql:289-293,303-308` |
| **A keyed digest is pseudonymisation, not anonymisation.** Anyone holding the secret can confirm a guessed address. The code says so; counsel should assume the weaker property | `apps/api/src/plugins/request-context.ts:25-27` |
| The identity provider is asked for `openid profile` and exactly four name-shaped claims are read as a display-name candidate; only `iss` and `sub` are persisted. The rest arrive in the ID token, transit the process, and are discarded — **received, briefly held in memory, not stored** | `apps/api/src/auth/oidc.ts:124,818-825`; email is "not requested, not read, not stored" at `:29-31` |
| The audit log's `detail` is policed by a `CHECK` refusing top-level keys naming a token, IP, user agent, invite code, deck, salt or hole cards, **widened on 2026-08-27** to the spellings this codebase actually uses for a card | `db/migrations/0001_initial.sql:868-874`; `db/migrations/0007_audit_forbidden_keys.sql` |
| The real control is the boundary redactor, which **removes** forbidden keys at every depth and records the dropped names | `apps/api/src/repositories/audit.ts:160-164,227-255` |
| **Erasure exists and verifies itself**: the tables naming the learner are counted before and again after, inside the same transaction, and anything surviving rolls the erasure back rather than reporting a deletion that did not happen. Nine subqueries, including `prl.enrolments` | `apps/api/src/repositories/users.ts:376-388,580` |
| **Access and portability do not exist as a product feature.** The route inventory contains no export endpoint. `GET /me/progress` returns progress only — not the account row, sessions, memberships, hand history in a portable form, or audit entries | `apps/api/src/routes/progress.ts:97` |
| **Rectification does not exist as a product feature either — corrected here.** The register says a display name can be renamed. A repository function `rename` exists and is written to be called, but **nothing calls it**: no route, no socket frame, no operator command, and no test. A learner's display name is fixed at the moment the account is created and cannot be changed by anybody through this application | `apps/api/src/repositories/users.ts:272-293`, and a repository-wide search for a caller returns only that definition |
| **Objection has no mechanism**, and there is no consent mechanism anywhere in this product | schema and routes: no consent, preference or objection table or column |
| A paying student is far likelier to exercise a right than an anonymous visitor, and an operator's only tool today is manual SQL | — |

#### What changes per answer

| Answer | What changes | Cost |
|---|---|---|
| Rights are satisfied as implemented | Answer recorded; prose replaces the §2 marker | **Recorded** + page wording |
| Portability is required | A scoped export endpoint (`GET /me/export`), returning the account row, memberships, progress, quiz and scenario attempts, and hand history filtered by the existing entitlement rule — never another seat's unshown hole cards (`apps/api/src/repositories/hands.ts:765-769`). Must be rate-limited like `/me/delete` | **Code** (register E1) |
| Rectification is required | The display name is the only field a learner could plausibly rectify, and there is no route to it. The repository function exists, so this is a route, a schema for its body, a rate limit and a test — not a redesign. Every other field is server-generated or comes from the identity provider | **Code** |
| A basis requiring consent for any category | There is no consent mechanism anywhere in this product; adding one is real work and adds a category to the inventory | **Migration** + code |

---

### B4 · `retention-and-deletion` — the periods, and what erasure must remove

**Blocks:** launch, once money is involved · **Review entry 7 · register L5** ·
**Flagged on** `/privacy` §5 (`apps/web/src/app/privacy/page.tsx:464`, heading at `:421`).

#### The decision

1. **How long may each category in the inventory be kept?**
2. **Does erasure require the hand history to be deleted rather than detached** from its account?
3. **How long may backups keep an erased learner's rows?**
4. **How long may operational logs be kept?** (Nothing implements a period today; see below.)
5. **Should an account whose only enrolment was revoked long ago still be protected from the
   abandoned-guest sweep?** It is today, deliberately, and narrowing that is a retention decision.

#### Facts counsel can rely on

| Fact | Where to check it |
|---|---|
| A session's **idle** window is 14 days and slides forward past the halfway point, bounded by an **absolute ceiling of 60 days from creation** | `apps/api/src/repositories/sessions.ts:41,251-272`; `apps/api/src/auth/session.ts:66,75,83` |
| The sweeps that remove expired rows **now run on a schedule** — every six hours, in bounded batches, first tick 60 seconds after boot, not environment-overridable. The register recorded them as existing and uncalled; that was true when it was written and is not now | `apps/api/src/maintenance/retention-sweep.ts:210-213,420` |
| A revoked session row is eligible at +24 h and removed at the next tick, so 24–30 h; a sign-in attempt stops working at 10 minutes and its row goes at the next tick, up to ~6 h 10 min later | `apps/api/src/repositories/sessions.ts:50,67` |
| **Abandoned guest accounts are erased sixty days after they were last seen.** The number is **derived, not chosen**: no specification states one, and a guest has no email, no password and no federated identity, so its only credential is a session cookie that cannot outlive the 60-day absolute ceiling. It is written as that constant, not as a literal | `apps/api/src/maintenance/retention-sweep.ts:123,131` |
| That period is a **floor, not the whole rule.** Five things protect an account at any age: a live session, a table membership, a seat in any hand, a room of its own, **and any enrolment** — including one revoked two years ago | `apps/api/src/repositories/users.ts:685-700` |
| Whether the broad enrolment clause is the right one is **explicitly left to counsel**, not decided by an engineer: erasing a student three weeks before their course starts and keeping a row nobody needs are not the same size of error | `apps/api/src/repositories/users.ts:663-668` |
| The sweep erases through the same `deleteAccount` path as `POST /me/delete`, one transaction each, with the same self-verification | `apps/api/src/repositories/users.ts:744-746` |
| A sweep that silently stops is invisible — "removed nothing" and "did not run" are the same flat counter — so it exports its own age and an alert reads that | `docs/production/alerts.md:513-521`; `docs/production/runbooks/retention-sweep-stalled.md` |
| **Account deletion deletes** the account row, sessions, lesson progress, quiz attempts, scenario attempts, table memberships and **every enrolment**; **detaches** hand seats, audit rows and owned rooms to NULL; and **retains every hand in full** | `apps/api/src/repositories/users.ts:446-600`; `db/migrations/0004_account_deletion.sql:30-32,162-164,183-185`; `db/migrations/0006_cohort_enrolments.sql:269-270` |
| **Deleting hand history is not a policy toggle.** The runtime role holds **no `DELETE` privilege at all** on `prl.hands`, `prl.hand_seats` or `prl.hand_actions`, and the grant is withheld on purpose | `db/migrations/0001_initial.sql:945-953` |
| A departed learner's hole cards remain with `user_id` NULL. No API viewer can read them — the SQL requires `showed_down` or a matching viewer, and NULL matches nobody — but the backup role, the migrating role and the superuser can | `apps/api/src/repositories/hands.ts:765-769`; `db/migrations/0001_initial.sql:671-677` |
| **Backups hold erased rows for up to roughly six months**: 7 daily, 4 weekly, 6 monthly, and **the newest good backup of every source database is never deleted whatever the policy says** — so indefinitely if backup creation stops | `scripts/backup.mjs:188-190,1288-1296,1352-1353` |
| Backups are read by a role holding `pg_read_all_data` — **every row of every table, including every hole card ever dealt** | `deploy/backup/README.md:61-64` |
| **Container logs are size-capped and have no retention period, and the two must not be confused.** A size cap bounds how much is kept and says nothing about how long. Nothing in this deployment implements "logs are kept for N days" and no value of `max-size` can | `docs/production/legal-register.md` §2.11, E12 |
| The proxy access log carries a /24 (or /48), a user-agent class, and the path with the query string already removed — **and a network prefix is reduction, not anonymisation**, a weaker property than the keyed HMAC the application stores | `deploy/staging/nginx.conf`; `docker-compose.yml`; enforced by `scripts/supply-chain/log-policy.mjs` |
| `prl.audit_log` rows survive an account deletion with `user_id` NULL and **nothing ever removes them** — including the enrolment rows carrying the external `reference` an operator typed | `db/migrations/0001_initial.sql:855-856` |
| No sweep exists for `prl.enrolments` or `prl.cohorts` and none is planned: a withdrawal an operator cannot evidence is worth nothing | `apps/api/src/maintenance/retention-sweep.ts` |

#### What changes per answer

| Answer | What changes | Cost |
|---|---|---|
| Detachment of hand history is sufficient | Nothing changes; the answer is recorded and prose replaces the §5 marker | **Recorded** + page wording |
| Hand history must be **deleted** | A migration, a change to the least-privilege grants, **and a decision about the other four players in each hand**, whose history it also is | **Migration** + code + a further decision |
| A different guest-account period | One constant (`GUEST_RETENTION_SECONDS`). A test fails if the constant and the derivation disagree | **Code**, one line |
| The enrolment clause in the sweep must be narrowed to live places only | One clause in `abandonedGuestPredicate`, plus an index that does not exist yet (the current index is partial on `revoked_at IS NULL`) | **Code**, possibly a **migration** for the index |
| Backups must not outlive erasure | Either a shorter policy at `scripts/backup.mjs:188-190` or a documented re-erasure step after a restore. **An archive cannot be edited without destroying the property that makes it trustworthy** | **Configuration** or runbook |
| Operational logs must be kept for N days | Neither a size cap nor logrotate can do this — the Docker daemon owns those files. It needs a log driver shipping to a store with a time policy, or a periodic sweep honest about racing the daemon | **Code / deployment** (register E12) |
| Any stated period at all | `/privacy` §5's four retention constants are read out of the API source by a test, so the page and the code cannot disagree again | **Page wording** |

---

### C1 · `play-money-classification` — is this a regulated product anywhere it will be offered

**Blocks:** launch, whether or not anybody is charged · **Review entry 3 · register L3** ·
**Flagged on** `/terms` §10, Regulatory status (`apps/web/src/app/terms/page.tsx:358`) **and**
`/responsible-use` §6 (`apps/web/src/app/responsible-use/page.tsx:213`).

**Highest blast radius in this pack.** `docs/THREAT-MODEL.md:17-22` records that the absence of a
financial motive is what lets collusion and bot-farming be rated low severity, so an answer here
moves security ratings as well as legal ones.

#### The decision

1. **Does a product with no stake, no purchase of play, no prize and no cash-out fall within any
   gambling, lottery, skill-gaming or advertising regime** in each place this deployment is offered?
2. **Does charging for a surrounding course change that analysis?**
3. **Does gating table access on a paid enrolment change it** — given that `PRL_ENROLMENT_REQUIRED`
   now exists and a fee could therefore stand between a reader and a poker table, even though nothing
   about the table changes?

Question 3 did not exist when this entry was written and is the one thing in it that is new.

#### Facts counsel can rely on

| Fact | Where to check it |
|---|---|
| No money enters or leaves; no purchase, deposit, subscription tied to play, prize, tournament with an external reward, or cash-out | §0 above, with the whole search |
| No column anywhere in the schema could hold a balance of money, and no endpoint transfers a unit between accounts | `db/migrations/0001_initial.sql:4-9` |
| Units are free, resettable at will, valueless. The reset is unconditional, never penalised, has no cooldown and no confirmation gate — a deliberate product guardrail | `apps/api/src/routes/auth.ts:14-18,1110-1115` |
| Tables are **invite-only**, enforced by a `CHECK` constraint with a single allowed value, so there is no public lobby and no matchmaking between strangers. Turning it on requires a migration (ADR 0010) | `db/migrations/0001_initial.sql:403-404` |
| No advertising, no affiliate or referral link, no gambling operator anywhere; the content-security policy has no host for a third party | `apps/web/src/lib/csp.ts:79,136` |
| No score, no streak, no leaderboard, no daily reward — **and no column any of them could be stored in** | `db/migrations/0001_initial.sql:781-783`; `docs/PRODUCT-GUARDRAILS.md:37-58` |
| Prohibited outright: purchases, deposits, top-ups or subscriptions **tied to units**. A course fee is not tied to units | `docs/PRODUCT-GUARDRAILS.md:14-19` |
| Content is policed by an automated phrase blocklist failing the build on "real money", "cash out", "withdraw", "deposit", a currency symbol or a daily-bonus framing; the UI cannot render a bare number without the word "units" | `packages/content/test/scenarios.test.ts:311-326`; `packages/ui/src/format.ts:180-198` |
| The one claim the product makes about transfer of skill is a constant with a test on it, so it cannot be softened by somebody improving the copy | `apps/web/src/lib/legal-config.ts:120-126` |
| **New since this entry was written:** a live enrolment can be made a condition of taking a seat. Nothing about the table, the units or the absence of a stake changes; what changes is that access to it can sit behind an out-of-band grant | `apps/api/src/rooms/registry.ts:1312-1327`; `docs/production/go-live.md:181` |

#### What changes per answer

| Answer | What changes | Cost |
|---|---|---|
| Outside every regime where it is offered | Nothing changes; the answer is recorded and prose replaces the two markers | **Recorded** + page wording |
| Inside one somewhere | Not a code change first — a decision about where the deployment is offered, and then whatever that regime requires | Outside this repository |
| Gating a table behind a paid enrolment changes the analysis | Do not set `PRL_ENROLMENT_REQUIRED=enforced` on a charging deployment, or change what the fee buys. `off` is the default and every deployment today is ungated | **Configuration** |

---

### C2 · `age-threshold` — the minimum age, and whether one is required at all

**Blocks:** launch, whether or not anybody is charged · **Review entry 2 · register L2** ·
**Flagged on** `/terms` §3 (`apps/web/src/app/terms/page.tsx:219`) **and** `/responsible-use` §4
(`apps/web/src/app/responsible-use/page.tsx:177`), with the gate itself at `/age-check`.

#### The decision

1. **Is a minimum age required for a play-money poker simulator** in each place this deployment is
   offered?
2. **If so, what is it?** (13–25 is the band the code accepts.)
3. **Is an unverified self-declaration sufficient?** Yes / no. This is the load-bearing one: a
   self-declaration is all the gate implements and all it can implement without collecting identity
   documents.
4. **Which surfaces must a gate cover** — the tables only, every surface on which a reader makes a
   poker decision, or the whole site?
5. **Does onboarding students who may be minors change any of the above?**

#### Facts counsel can rely on

| Fact | Where to check it |
|---|---|
| **The software ships with no age gate.** `PRL_AGE_GATE` is `off`, and the pages say in an unmissable notice that nobody has decided, rather than implying a threshold nobody chose | `.env.example:528`; `apps/web/src/lib/age-gate.ts:141,222-227` |
| The threshold band is 13–25, default 18, and an out-of-range value is **clamped into the band rather than replaced by the default** — falling back to a lower number would quietly weaken a control the deployer meant to be strict | `apps/web/src/lib/age-gate.ts:107,115-119` |
| **Every unreadable value resolves to the stricter reading**: an unrecognised mode shows the gate, an unrecognised scope covers the whole site. A misconfiguration is never the reason a gate is skipped, and each one lands in `problems`, which the pages render | `apps/web/src/lib/age-gate.ts:241-247` |
| **It verifies nothing and stores no date of birth. There is no column in the schema that could hold one.** Real verification means identity documents — a far larger privacy exposure than the thing it protects against, needing its own threat-model review | `apps/web/src/lib/age-gate.ts:25-34` |
| The cookie's **value is the threshold declared against**, not a flag, so raising 18 to 21 re-asks. A boolean would have carried every existing reader past the new number. It lasts 180 days | `apps/web/src/lib/age-gate.ts:96,334-338` |
| A reader who declares they are under the threshold is **not locked out and not recorded** — they are shown why the gate exists and where the reading material is. A lockout on a self-declaration enforces nothing | `apps/web/src/lib/age-gate.ts:31-34` |
| **The declaration is accepted on a `GET`**, so it works with JavaScript disabled and with no route handler. A third party can therefore cause a reader's browser to submit it by sending them a link — which changes nothing the reader could not do by pressing the button, and there is no account state behind it. Counsel should hear it from us | `apps/web/src/lib/age-gate.ts:470-478,484-495` |
| **`/terms`, `/privacy`, `/responsible-use` and `/age-check` are never gated at any scope.** A privacy policy readable only by people who already answered a question about themselves is not a privacy policy | `apps/web/src/lib/age-gate.ts:154-160` |
| **The scope named `play` covers `/play` and nothing else.** It does **not** cover `/lab` (the scenario lab — simulated poker decisions), `/review` or `/legends`. "The simulated tables only" is accurate about `/play` and does not describe every surface on which a reader makes a poker decision | `apps/web/src/lib/age-gate.ts:163` |
| The gate switched **on** is exercised by a release gate that starts its own production build and drives a real browser, at a threshold deliberately not the built-in default so a server ignoring its configuration cannot pass | `package.json` (`test:age-gate` in the `verify` loop); `scripts/age-gate-audit.mjs` |
| **That check found a real defect**: with the gate on, clicking "Play" in the site header went straight to the tables every time, because in-app navigation was decided by a header Next deletes before middleware runs. Fixed, with the pure halves under ordinary unit test | `apps/web/src/lib/guest-bootstrap.ts:134,152,211`; `docs/production/legal-review-requirements.md` follow-up 5 |

#### What changes per answer

| Answer | What changes | Cost |
|---|---|---|
| No gate is required | Leave as shipped; the notice stays honest. Answer recorded, prose replaces the markers | **Recorded** + page wording |
| A threshold, on the tables only | `PRL_AGE_GATE=on`, `PRL_AGE_GATE_MINIMUM_AGE`, `PRL_AGE_GATE_SCOPE=play`, `PRL_AGE_GATE_JURISDICTION`. Note: the browser harnesses need `PRL_AGE_GATE=off` in their own environment or they audit the interstitial | **Configuration** |
| The gate must cover every poker surface | Widen `AGE_GATE_PLAY_PREFIXES` (`apps/web/src/lib/age-gate.ts:163`) or choose `PRL_AGE_GATE_SCOPE=site` | **Configuration** or a one-line **code** change (register E8) |
| Self-declaration is insufficient | **Not a configuration change.** Collecting identity documents, a new data category in the inventory, a new retention period, and its own threat-model review | **Migration** + code + a new review |
| A jurisdiction must be named | `PRL_AGE_GATE_JURISDICTION`. Unset, the gate tells the reader in as many words that the number is tied to no jurisdiction | **Configuration** |

---

### C3 · `international-transfer` — where the data sits, and who may reach it

**Blocks:** launch, whether or not anybody is charged · **Review entry 8 · register L6** ·
**Flagged on** `/privacy` §7 (`apps/web/src/app/privacy/page.tsx:537`, heading at `:521`).

#### The decision

1. **In which country does this deployment run its database and its backups?**
2. **Who administers them** — in particular the backup host, given the privilege that role holds?
3. **What transfer mechanism or disclosure does that require** for the readers this deployment
   serves?
4. **Must the operator disclose its infrastructure provider, and any system the enrolment
   `reference` points into, as sub-processors?**

Question 4 is the register's **L12**, which has **no marker on any page** — see §3 below. It is
listed here because it is the same conversation and a lawyer answering (3) will have the facts for it
in front of them.

#### Facts counsel can rely on

| Fact | Where to check it |
|---|---|
| The application makes **no outbound connection** other than to its own database and, if configured, an OIDC identity provider | `apps/api/src/auth/oidc.ts:892,901` |
| No analytics, error reporting, CDN, remote font or advertising — the content-security policy has no host for any of them | `apps/web/src/lib/csp.ts:79,136` |
| `PRL_LEGAL_HOSTING_REGION` is what the page displays, and it is unset | `apps/web/src/lib/legal-config.ts:418`; `.env.example:556` |
| **The widest reader in the system is the backup role**: `pg_read_all_data` — every row of every table, including every hole card ever dealt — plus `CREATEDB` and membership of the migrating role | `deploy/backup/README.md:61-64` |
| Backups are encrypted, taken nightly, verified and pruned weekly, and can hold a row for up to roughly six months | `deploy/backup/prl-backup.timer:18`; `scripts/backup.mjs:188-190` |
| The identity provider learns that a given subject signed in here, and when. It receives no learner content | `apps/api/src/auth/oidc.ts:124` |
| Metrics carry **no label that is or could be** a user id, session id, room id, hand id, IP or display name; the only request-derived label is the route pattern or the fixed string `unmatched`, and cardinality is hard-capped | `apps/api/src/observability/metrics.ts:16-20,174-177`; `apps/api/src/observability/registry.ts:54,174-193` |
| An enrolment's `reference` is meaningful in some system outside this one; **this application never contacts that system**, and only the operator can say what it is. The join runs the other way — somebody holding both databases can link a person to a record there | `db/migrations/0006_cohort_enrolments.sql:32-37`; `apps/web/src/app/privacy/page.tsx:521-536` |

#### What changes per answer

| Answer | What changes | Cost |
|---|---|---|
| A named region | One environment variable and a redeploy | **Configuration** |
| A transfer mechanism or disclosure is required | Prose replacing the §7 marker, plus whatever the hosting arrangement itself requires | **Page wording** + operator work |
| A sub-processor disclosure list is required | A new `/privacy` section. Its contents depend on operator choices this repository cannot know | **Page wording** (register E14) |
| The identity provider must be minimised | Request `openid` alone plus a generated display name the learner can change. **The register says the rename path already exists; it does not** — the repository function has no caller, so this needs the route B3 also needs | **Code**, one line plus the missing rename route (register E4, and see §4) |

---

### C4 · `ai-legend-naming` — name, image and likeness for attributed opponent profiles

**Blocks:** a feature, not the launch · **Review entry 9 · register L9** ·
**Flagged on** `/terms` §5 (`apps/web/src/app/terms/page.tsx:263`) **and** `/responsible-use` §5
(`apps/web/src/app/responsible-use/page.tsx:189`).

**This entry is already fenced, which is why it is last.** `PRL_LEGEND_NAMING` is unset and resolves
to `archetype` — generic style names only. ADR 0011 makes the safe mode the default precisely so that
a deployer who never reads this document cannot ship attributed names by accident, and **setting the
variable is the act that is supposed to prompt this question**. Until this is answered in writing it
must stay unset. Answering it "no" costs nothing at all; the product is complete without it.

#### The decision

1. **May this deployment display the attributed names carried in `packages/poker-ai`?** Yes / no.
2. **If yes, on what permission** — and from whom, for a subject who has died?
3. **Does featuring them in a course somebody paid for change the permission needed?**

#### Facts counsel can rely on

| Fact | Where to check it |
|---|---|
| The profiles are **not** simulations of real people. Each is a sixteen-axis numeric trait vector built from tendencies discussed publicly in general terms — not from anyone's hand histories, private decisions or thinking | `docs/adr/0011-strategy-profiles-not-celebrity-simulation.md:16-21`; `docs/AI-LEGENDS.md:17,226`; the axes themselves in `packages/poker-ai/src/traits.ts` |
| The educational content is **byte-identical** in both naming modes — the traits, the counter-strategy, the model basis, every computed figure. Only the identity fields change | `docs/AI-LEGENDS.md:95-98` |
| No commentary narrates any person's thoughts. An impersonation check runs over every learner-facing string at profile load **and again on every generated commentary string** | `packages/poker-ai/src/labelling.ts:251`; `packages/poker-ai/src/profiles.ts:805`; `packages/poker-ai/src/commentary.ts:345` |
| The reasoning type has no field capable of holding a mental state | `packages/poker-ai/src/policy.ts:147` |
| Disclaimers are **structured data**: there is no code path producing a profile card without them. They state that the profiles are "not real people, not digital copies of anyone, and not endorsed by" anyone. Attributed mode adds a further one | `packages/poker-ai/src/labelling.ts:91,124,148` |
| Some subjects under consideration have died. That changes nothing about the analysis: being unable to object is not a reason to be less careful | `docs/adr/0011-strategy-profiles-not-celebrity-simulation.md` |
| The variable is a commented placeholder in the example environment file | `.env.example:573` |

#### What changes per answer

| Answer | What changes | Cost |
|---|---|---|
| No | Leave unset for ever. Answer recorded, prose replaces the two markers | **Recorded** + page wording |
| Yes, with written permission | One environment variable. The further attributed-mode disclaimer already exists | **Configuration** |
| Yes for some subjects and not others | Nothing supports a per-profile mode; the switch is deployment-wide | **Code** |

---

## 3. Two decisions the register raises that have no marker on any page

Recorded here so a lawyer is not surprised by them later. **They are not among the eleven**, and this
document does not add them to the register — that is `legal-review-requirements.md`'s to do, and the
register tracks the gap as **E14**.

* **`sub-processors` (register L12)** — who else processes student data on the operator's behalf.
  Most of the answer is not in this repository. The facts that are, are folded into **C3** above.
* **`accessibility-and-record-keeping` (register L13)** — whether an accessibility standard binds
  this as a paid educational service, and what records must be kept about a paying student. Two facts
  matter and both are checkable. `docs/PRODUCT-GUARDRAILS.md:119` states WCAG 2.2 AA as a binding
  internal commitment; **no accessibility claim is made on any user-facing page**, which is the
  honest position, because
  `docs/production/accessibility-certification.md:9-12` says *"BLOCKED — UNVERIFIED. Nothing in this
  repository has ever heard this application read aloud, and no gate in it can."* And the
  record-keeping half is in direct tension with a guardrail: quizzes have **no score threshold, no
  pass/fail and no aggregate score column**, and no column any of them could go in
  (`docs/PRODUCT-GUARDRAILS.md:53-55`; `db/migrations/0001_initial.sql:781-783`). Being asked to
  evidence course completion would mean changing a guardrail and the schema, deliberately.

---

## 4. What was found stale while verifying this pack

Every fact above was re-read out of the working tree on 2026-08-27. **Where a source document and the
code disagreed, the code won and the correction is recorded here rather than smoothed over.** None of
these changes an answer; several change what an answer costs.

### Substantive

1. **`legal-register.md` L10(b): "Nothing is gated on entitlement yet … no route consults
   `prl.enrolments` to decide what a reader may see."** **No longer true.**
   `PRL_ENROLMENT_REQUIRED=enforced` makes a live enrolment a condition of taking a seat — added in
   `5e2753a` on 2026-08-25, the same day the migration landed and after that entry was written
   (`apps/api/src/config.ts:827-833`, `apps/api/src/rooms/entitlement.ts`,
   `apps/api/src/rooms/registry.ts:1312-1327`), and `docs/production/go-live.md:181` makes switching
   it on step 6.5 of cohort onboarding. This moves work out of **A1**'s "gated" branch — the
   mechanism exists — and adds a genuinely new sub-question to **C1**: a fee can now stand between a
   reader and a poker table.
2. **`legal-review-requirements.md` entry 7: "the sweeps … at the time of drafting nothing called
   them on a schedule."** The hedge is honest but a lawyer reading only the fact list would be
   misled. They run every six hours (`apps/api/src/maintenance/retention-sweep.ts:210-213,420`);
   follow-up 2 of that same document records it. Stated correctly under **B4**.
3. **`legal-register.md` L13(b): "`test:keyboard` … is **not** in `verify`, `test` or `test:all`"
   and "**Two** automated gates run in `verify`."** `test:keyboard` is now in the `verify` loop
   (`package.json`), so three accessibility gates run there, not two. The conclusion that none of
   them involves a screen reader is unchanged, and so is the UNVERIFIED status.
4. **`legal-register.md` L4(b): "Rectification of a display name exists (rename)", and E4: "the
   rename path already exists."** **It does not.** `apps/api/src/repositories/users.ts:272-293`
   defines `rename` and a repository-wide search finds **no caller at all** — no route, no socket
   frame, no operator command, and no test. A display name is fixed when the account is created.
   This changes **B3**: access, portability **and** rectification are all absent, not two of three.
   It also weakens E4's proposal, which was to narrow the identity-provider scope to `openid` and
   let the learner rename themselves afterwards — that second half has to be built first.
5. **`legal-register.md` §1: "exactly two `fetch()` call sites in the whole application."** There
   are three (`apps/web/src/lib/api.ts:397`, `apps/web/src/lib/guest-bootstrap.ts:251,271`). All
   three are same-origin and the conclusion holds unchanged.
6. **`legal-register.md` L11(b) and entry 11: "the word 'refund' appears nowhere in the
   application."** Looser than the code supports. It occurs as this clause's own id and question
   text (`apps/web/src/lib/legal-config.ts:133,246-256`;
   `apps/web/src/app/terms/page.tsx:45,340`) and in one rate-limiter comment
   (`apps/api/src/routes/auth.ts:151`). **The substantive claim — no refund mechanism, no column, no
   route — is unaffected**, and is stated in the checkable form under **A2**.

### Citations that no longer land where they say

7. **`scripts/backup.mjs:1238-1247`** for "the newest good backup is never deleted whatever the
   policy says" (`legal-register.md` §2.11, §5 L5). That range is now the `--id` archive-selection
   error path. The rule is at **`:1288-1296`** (the reasoning) and **`:1352-1353`** (the code).
8. **`docs/production/accessibility-certification.md:5-9`** for "BLOCKED — UNVERIFIED"
   (`legal-register.md` L13). The file gained a candidate-SHA provenance correction at the top;
   `:5-9` is now that correction and the status is at **`:9-12`**.
9. **`apps/api/src/repositories/enrolments.ts:504,516,570`** for the three audit writes
   (`legal-register.md` §2.9, §3.2). They are at **`:523`** (superseded), **`:535`** (granted) and
   **`:590`** (revoked); the grant detail carrying the external `reference` is **`:535-547`**.
10. **`apps/api/src/routes/auth.ts:633` / `:628-637`** (unit reset) and **`:683-719` / `:686`**
    (`POST /me/delete`) (`legal-register.md` §1, §3.1, L3). Now **`:1110-1115`** and **`:1166-1173`**.
11. **`apps/api/src/repositories/users.ts:417`** (`deleteAccount`) and **`:352-369,482-494`**
    (`accountFootprint`) (`legal-register.md` §3.1). Now **`:446`** and **`:376-388,580`**.
12. **`apps/api/src/repositories/hands.ts:764-767`** (the hole-card viewer rule). The `case`
    expression runs **`:765-769`**.
13. **`apps/web/src/lib/age-gate.ts:107,118-119`** for the clamping argument
    (`legal-register.md` L2). `:118-119` are the floor and ceiling constants; the reasoning is
    **`:115-119`**.
14. **`test:age-gate` "is release gate eleven of fourteen"** (`legal-register.md` L2(b)) and
    "**eleventh of the fourteen**" (`legal-review-requirements.md` follow-up 5). `pnpm run verify`
    now runs **sixteen** gates and `test:age-gate` is the **thirteenth**. The claim it is the only
    check exercising the gate switched on still holds.
15. **A comment beside `accountFootprint` still says "the **eight** tables that name the learner"**
    (`apps/api/src/repositories/users.ts:742`). There are nine subqueries and `prl.enrolments` is
    among them, so the erasure's self-verification does cover it — which is what
    `legal-register.md` §3.1's "count the subqueries" instruction was for. The count in that
    neighbouring comment is one behind the code; the guarantee is intact.

### Re-checked and still correct

* **The `/privacy` §2 inventory is complete.** `legal-register.md` §2 asks for a re-check against
  `db/migrations/` before this is sent to counsel. `db/migrations/0007_audit_forbidden_keys.sql`
  landed on 2026-08-27 and **creates no table** — it adds a second forbidden-key constraint beside
  0001's, `NOT VALID` so it is enforced forward without scanning history. Nothing was added to the
  inventory and nothing needed to be.
* **Every one of the eleven clause markers is on the page the register assigns it**, at the section
  the register names, including the `/terms` §8→§9 correction the register made on 2026-08-26.
  Verified line by line against `apps/web/src/app/{terms,privacy,responsible-use}/page.tsx`.
* **The schema still holds no amount, currency or price column**, and the build-time detector that
  says so covers `apps/web/src`, `apps/api/src` and every `packages/*/src`, enumerating the packages
  rather than listing them.
* **No accessibility claim is made on any user-facing page.** Swept across
  `apps/web/src/app/**/*.tsx` for "WCAG" and "accessib": every occurrence is a source comment or a
  design-fixture description, and none is a representation to a reader. That is what makes the
  UNVERIFIED certification status in §3 the honest position rather than a contradiction.

### Outside this pack, noticed while reading

* `README.md:90,246` say the repository holds **twelve** decision records. `docs/adr/` holds
  **thirteen** (0001–0013). Not touched here — it is not a legal document and no test asserts it.
* `apps/api/src/repositories/users.ts:279` exports `rename` with a comment explaining why the grant
  matrix allows it, and nothing calls it. Whether that becomes a route or is deleted is B3's answer
  to make; either way an exported function with no caller and no test is the shape a guard is
  supposed to catch.

---

## 5. What this document deliberately does not do

It answers no question above, names no jurisdiction, asserts compliance with no regime, claims no
part of this product is or is not regulated, and **contains no draft clause text of any kind**. Every
entry is written as a decision so that an answer is a thing somebody can be shown to have given, with
a date on it, by somebody qualified in each place this deployment will be offered.

It does not replace [`legal-review-requirements.md`](legal-review-requirements.md), which is the
machine-checked register and the only list the build holds the pages to, and it does not replace
[`legal-register.md`](legal-register.md), which carries the full reasoning behind each fact. If this
document and either of those disagree, **check the code**: the corrections in §4 are what happens
when it is checked.
