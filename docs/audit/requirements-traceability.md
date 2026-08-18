# Requirements Traceability Matrix

**Audit date:** 2026-08-18
**Auditor:** independent principal release auditor, plus eight independent reviewers (A–H) and one
final challenger, all running the same model at the same effort, each forming its conclusions
before seeing any other's.

---

## 0. Provenance of the acceptance contract — read this first

**The original `/goal` prompt is not recoverable.** The session that produced this implementation
(`0b0dd179-…`) has had its transcript deleted; only six workflow scripts survive under
`~/.claude/projects/…/0b0dd179-…/workflows/scripts/`. There is no `/goal` command definition in
`~/.claude/commands/` or `.claude/commands/`, and no goal document in the repository.

The acceptance contract used here was therefore **reconstructed** from five independent surviving
sources, and this is stated plainly because it bears on how the matrix should be read:

1. the `/audit-release` brief's own enumeration of required modes, outputs, guardrails and
   categories;
2. `README.md` — the product's own statement of what it does;
3. `docs/PRODUCT-GUARDRAILS.md` — the eight enforceable product rules;
4. `docs/REPORT.md`, `docs/VERIFICATION.md`, `docs/ARCHITECTURE.md` and the twelve ADRs — the
   implementer's claims, used to *extract claims to test*, never as evidence;
5. the six surviving workflow scripts, which encode requirement language passed to the original
   implementers (e.g. *“AI MUST NOT CHEAT — this is a hard architectural boundary”*, *“NEVER
   HARD-CODE A COMPUTED NUMBER”*, *“ACCESSIBILITY — WCAG 2.2 AA, a functional requirement”*).

**Consequence for this audit.** Where the reconstructed contract and the implementation agree, that
agreement is not proof the original goal was met — only that the documented intent was met. No
requirement below was invented to be passable, and none was narrowed to fit what was built; where
a requirement's exact original wording is unknown, the strictest reasonable reading was used.

---

## 1. How to read this matrix

Every requirement carries exactly one status:

| Status | Meaning |
|---|---|
| **PASS** | Concrete runtime evidence was produced by a reviewer. Existence of code, a type, a document or a test never earned a PASS. |
| **FAIL** | Requirement not met, with proof. |
| **PARTIAL** | Partially met; what is missing is stated. |
| **UNVERIFIED** | Could not be tested in this environment. **Never** treated as PASS. |
| **N/A** | Genuinely not applicable. |

**The complete nine-field record** — requirement ID, exact requirement, status, implementation
location (file + lines), runtime evidence, test covering it, test result, reviewer notes, missing
work — exists for **every one of the 203 requirements** in the reviewers' raw reports:

| Namespace | Reviewer | Raw report |
|---|---|---|
| `PROD-001…040` | A — product requirements | `raw/agent-a-product.md` |
| `ENG-001…023` | B — poker engine (adversarial) | `raw/agent-b-engine.md` |
| `MATH-001…013` | C — poker mathematics | `raw/agent-c-math.md` |
| `SEC-001…028` | D — security & multiplayer (offensive) | `raw/agent-d-security.md` |
| `SUP-001…019` | E — supply chain | `raw/agent-e-supplychain.md` |
| `UX-001…013`, `A11Y-001…018` | F — frontend & accessibility | `raw/agent-f-frontend.md` |
| `OPS-001…015` | G — data / production / SRE | `raw/agent-g-production.md` |
| `TEST-001…026` | H — test quality | `raw/agent-h-testquality.md` |
| `LEAD-001…008` | lead auditor — architecture & release hygiene | this document, §4 |
| `CHAL-*` | final challenger | `raw/challenger.md` |

This document indexes all of them, expands **every non-PASS requirement in full** (§5), and
summarises the PASS blocks with the evidence that earned them (§6). Counts in §3 were derived
mechanically from the reviewers' own status tables, not from their prose summaries — two reviewers'
prose counts were off by one against their own tables and have been corrected here.

---

## 2. Coverage of the twelve mandated categories

| # | Mandated category | Covered by | Reqs |
|---:|---|---|---:|
| 1 | GOAL / product requirements | `PROD-001…040` | 40 |
| 2 | Every required product mode | `PROD` (Learn, Guided Practice, Scenario Lab, Play-Money Tables, Hand Review, Tournament Learning, Coach) | within 40 |
| 3 | Every OUTPUT / deliverable | `PROD`, `OPS-015`, `LEAD-005` | within |
| 4 | Every GUARDRAIL | `PROD-029…038` (8 product guardrails), `LEAD-006` | within |
| 5 | Architecture requirements | `LEAD-001…006`, `ENG`, `SEC` | 8 + |
| 6 | Poker-engine / math requirements | `ENG-001…023`, `MATH-001…013` | 36 |
| 7 | Security requirements | `SEC-001…028` | 28 |
| 8 | Supply-chain requirements | `SUP-001…019` | 19 |
| 9 | Accessibility requirements | `A11Y-001…018` | 18 |
| 10 | Testing requirements | `TEST-001…026` | 26 |
| 11 | Operational / deployment requirements | `OPS-001…015` | 15 |
| 12 | Definition-of-Done items | `TEST-001`, `PROD-039`, `OPS-015`, `SUP-014`, `LEAD-007…008` | within |

**Note on category 12.** No standalone Definition-of-Done checklist survives. The DoD was taken to
be the repo's own declared release gate — `pnpm run verify` (`security:audit → hygiene → lint →
build → typecheck → design:contrast → test → db:verify`) — plus the reproduction list in
`docs/VERIFICATION.md` §13. Both were executed; see `runtime-verification.md` §1.

---

## 3. Counts

| Status | Count |
|---|---:|
| **PASS** | **143** |
| **FAIL** | **33** |
| **PARTIAL** | **31** |
| **UNVERIFIED** | **1** |
| **N/A** | **0** |
| **Total** | **208** |

*(203 from the eight parallel reviewers and the lead auditor, plus 3 new requirements raised by the
final challenger (§8) and 2 added during post-challenger reconciliation — `CHAL-D` and `LEAD-009`,
both FAIL, recorded in `final-release-audit.md` §11.3. The challenger's other 9 findings mapped onto requirements already in
this matrix and are recorded there rather than double-counted.)*

By reviewer (mechanically extracted from each report's status table):

| Namespace | Total | PASS | FAIL | PARTIAL | UNVERIFIED | N/A |
|---|---:|---:|---:|---:|---:|---:|
| PROD (A) | 40 | 26 | 10 | 4 | 0 | 0 |
| ENG (B) | 23 | 18 | 1 | 4 | 0 | 0 |
| MATH (C) | 13 | 11 | 1 | 1 | 0 | 0 |
| SEC (D) | 28 | 25 | 0 | 2 | 1 | 0 |
| SUP (E) | 19 | 12 | 3 | 4 | 0 | 0 |
| UX + A11Y (F) | 31 | 24 | 0 | 7 | 0 | 0 |
| OPS (G) | 15 | 10 | 2 | 3 | 0 | 0 |
| TEST (H) | 26 | 10 | 10 | 6 | 0 | 0 |
| LEAD | 9 | 7 | 2 | 0 | 0 | 0 |
| CHAL (challenger) | 4 | 0 | 4 | 0 | 0 | 0 |
| **Total** | **208** | **143** | **33** | **31** | **1** | **0** |

> Corrections applied: Reviewer H's prose reported 11 PASS / 5 PARTIAL; its own table is 10 / 6.
> Reviewer F's prose reported 23 PASS / 8 PARTIAL; its own table is 24 / 7 (it counted one ID's two
> defects separately). Reviewer E's counts block reported 11 PASS / 5 PARTIAL; its own table is
> 12 / 4. Tables were taken as authoritative in all three cases.

---

## 4. Lead auditor's own requirements (architecture & release hygiene)

These were audited by the lead auditor because no reviewer owned them.

| ID | Requirement | Status | Location | Evidence |
|---|---|---|---|---|
| LEAD-001 | Modular monolith: a pnpm workspace of six libraries and two apps | **PASS** | `pnpm-workspace.yaml`, `packages/*`, `apps/*` | Structure confirmed: `poker-engine`, `poker-math`, `contracts`, `content`, `poker-ai`, `ui` + `api`, `web` |
| LEAD-002 | The pure core has no external runtime dependencies, no I/O, no clock, no ambient state | **PASS** | `packages/poker-engine/package.json`, `packages/poker-math/package.json` | `dependencies: {}` for the engine; math depends only on `workspace:*` siblings. Scan for `Math.random`/`Date.now`/`new Date()`/`fs`/`http` in both `src` trees returned only `node:crypto` (required) and one defensive `process.env['NODE_ENV']` guard at `rng.ts:159` that **refuses** the deterministic test generator in production |
| LEAD-003 | Server-authoritative: no client message names a card, stack, pot, turn order or legal action | **PASS** | `packages/contracts/src/ws-protocol.ts:66-137` | The entire client→server union is `hello · sit · stand · action · requestCoach · startHand · ping`. `action` carries only `fold/check/call/bet{to}/raise{to}` plus `actionId` (idempotency) and `expectedSequence` (staleness). No card, stack, pot or legality field exists on the wire |
| LEAD-004 | Whole-state WebSocket frames; events are never load-bearing | **PASS** | `packages/contracts/src/ws-protocol.ts:155-175,224` | `WsState` carries the full redacted `PlayerView` + monotonic `revision`; the source states, and the type confirms, that *“a client that ignored every event would still render a correct table”* |
| LEAD-005 | The documented route inventory matches the implementation (13 web routes, 8 API route modules) | **PASS** | `apps/web/src/app/**/page.tsx`, `apps/api/src/routes/` | Exactly 13 `page.tsx` files matching the documented list; exactly 8 route modules (`auth, calc, content, hands, index, legends, progress, rooms`). Live boot reports `routeModules:7` + index |
| LEAD-006 | No public matchmaking and no chat; `rooms.visibility` constrained in the database | **PASS** | `db/migrations/0001_initial.sql:403-404` | `CONSTRAINT rooms_visibility_invite_only CHECK (visibility = 'invite_only')`. No chat implementation exists anywhere in `apps/api/src`, `packages/contracts/src` or the schema. Reviewer A independently proved the CHECK bites on the live database |
| LEAD-007 | The project is under version control, so a clean checkout can be taken and the audited tree has provenance | **FAIL** | — | `git rev-parse --is-inside-work-tree` → *fatal: not a git repository*; no `.git` directory exists. See §5 record LEAD-007 |
| LEAD-009 | Scenario seat `stack` semantics are documented and applied consistently | **FAIL** | `packages/contracts/src/content-types.ts:229`; `packages/content/data/scenarios/risk-and-sizing.json` | `ScenarioSeat.stack` carries no doc comment saying whether it is chips behind or total. In `rk-nine-big-blinds-call-or-fold` the small blind's whole stack is recorded as **both** `stack: 7200` and `committedThisStreet: 7200` while its own `facingAction` says that 7,200 *is* their whole stack — so a seat with nothing behind is presented to the maths as having 7,200 behind. The same scenario is titled “Nine big blinds” while giving hero 13.5 BB. See `final-release-audit.md` §11.3 |
| LEAD-008 | Format and lint gates pass | **PASS** | `biome.json` | `biome format .` → “Checked 348 files… No fixes applied”, exit 0. `pnpm run lint` → exit 0 with 2 advisory complexity warnings at `packages/content/src/validate.ts:670,865`, both pre-disclosed in `REPORT.md` §6.7 |

---

## 5. Every non-PASS requirement, in full

60 requirements are not PASS: **28 FAIL · 31 PARTIAL · 1 UNVERIFIED**. Each is expanded below.
Severity: **P0** release catastrophe · **P1** required feature broken/missing · **P2** significant
quality gap · **P3** polish.

### 5.1 Product requirements (Reviewer A)

#### PROD-020 — Coach: EV per **legal** action, with the arithmetic shown — **FAIL · P0**
- **Exact requirement:** the Coach must present expected value per *legal* action; it must never
  price or recommend an action the engine would reject.
- **Implementation location:** `packages/poker-math/src/coach.ts:153` (optional field), `:556`
  (the guard); `apps/api/src/workers/equity-worker.ts:105-120` (`CoachTask`, no such field);
  `apps/api/src/ws/router.ts:653` (only supplier).
- **Runtime evidence:** `coach.ts:556` reads
  `input.legalActions === undefined || input.legalActions.includes(action)` — when the field is
  absent **every action is treated as legal; the guard fails open**. `CoachTask`, the wire type used
  by Scenario Lab, Hand Review, Legends compare and `POST /math/coach`, has no field to carry it.
  Reviewer A measured 3 shipped scenarios where no opponent has chips behind and **2 that publish an
  illegal raise as the headline suggestion at `reasonable` confidence**, priced with 35 % fold
  equity against a player who cannot fold. *Mechanism independently re-verified by the lead auditor.*
- **Test covering it:** `apps/api/test/coach-legality.test.ts`
- **Test result:** **PASSES — and is worthless here.** It describes this exact bug in its header but
  hands `legalActions` to `buildCoachReport` itself instead of driving the production wire type.
- **Reviewer notes:** this inverts the codebase's own stated principle (ADR 0003, build narrowly
  *so that it fails closed*). The guard exists and is bypassed on 4 of 5 surfaces.
- **Missing work:** add `legalActions` to `CoachTask` and every caller; make the parameter
  **required**, or default to refusing aggression rather than permitting it; rewrite the test to
  drive the production path.

#### PROD-025 — Content integrity: no hard-coded computed number in web copy/fixtures — **FAIL · P0**
- **Exact requirement:** content stores situations, never answers; every number the learner sees is
  computed at runtime by `@prl/poker-math`.
- **Implementation location:** `apps/web/src/fixtures/scenarios.ts:959-962`, `:1001`, `:618`;
  `apps/web/src/fixtures/review.ts:450`; rendered by
  `packages/ui/src/components/CoachPanel.tsx:646-649`.
- **Runtime evidence:** `GET /lab/flop-spr-commitment` with the API down returns the string
  **“roughly 160%”**. Lead auditor confirmed `estimate: 1.6` in source and that the render path is
  unconditional. Three reviewers (A, C, H) found this independently.
- **Test covering it:** `apps/api/test/web-fixture-figures.test.ts`
- **Test result:** **FAILING** (`ERR_ASSERTION`, `deepStrictEqual`). The repo's own guard already
  detects the defect and has been left red.
- **Reviewer notes:** the *engine* was fixed — `coach.ts:271-278` refuses these cases and `:375-382`
  throws outside `0..1`. Only the fixture was never regenerated.
- **Missing work:** regenerate fixtures from the engine (do not hand-edit); make the guard
  release-blocking.

#### PROD-026 — Content integrity: authored teaching point agrees with the computed suggestion — **FAIL · P0**
- **Exact requirement:** a scenario's taught lesson must not contradict the analysis the product
  computes for it.
- **Implementation location:** `packages/content` scenarios `rk-the-fold-that-feels-wrong`,
  `eq-implied-odds-deep-stacks-turn`; `isDefensible` / `DEFAULT_ASSUMED_FOLD_EQUITY = 0.35`.
- **Runtime evidence:** `POST …/attempt {"action":"fold"}` on a scenario titled *“Folding top pair,
  top kicker”*, which asks *“call or fold?”* and whose own prose concludes *“folding is better than
  calling”*, answers **“fold is not consistent with this analysis”** and writes
  `matched_expected = false`. The Coach headlines `raise` in 26–30 of 36 authored spots.
- **Test covering it:** none. `packages/content/src/validate.ts` checks `expectedInsight` only.
- **Test result:** n/a — build stays green.
- **Reviewer notes:** corroborated independently by Reviewer C (MATH-012).
- **Missing work:** assert every scenario's taught action is in its own defensible set; revisit the
  flat fold-equity assumption feeding `bestEv`.

#### PROD-039 — The release candidate's own test suite is green — **FAIL · P1**
- **Runtime evidence:** `pnpm run test` → **exit 1** (534 integration tests, 532 pass, 2 fail).
  `pnpm run verify` therefore cannot pass. CI runs this command. Reproduced three times identically.
- **Missing work:** fix PROD-025; do not suppress the guard.

#### PROD-011 — Play-Money Tables: join a private table by invite code — **FAIL · P1**
- **Exact requirement:** private, invite-only tables playable with people you already know.
- **Implementation location:** `apps/web/src/lib/table-rooms.ts` exports only `ensureSession`,
  `listRooms`, `createBotRoom`, `chooseRoom`.
- **Runtime evidence:** lead auditor confirmed `grep -rn "inviteCode|invite_code|inviteToken"
  apps/web/src` returns **zero matches**. The invite code is generated by the API, never displayed,
  and discarded. There is no join-by-code flow. `/play` creates a **bot** table only.
- **Reviewer notes:** the server side genuinely works — Reviewer D completed a full private hand
  with two independent sessions, and the lead auditor's load run completed 5/5 hands across 3
  sessions. **A required product mode is unreachable by a user despite a working backend.**
- **Missing work:** surface the invite code on room creation; build a join-by-code entry point.

#### PROD-004 — Learn: quiz attempts are recorded — **FAIL · P1**
`QuizRunner` grades client-side; `quizAttempt` is the only `API_PATHS` entry with **zero call
sites**. No attempt is ever submitted. Progress cannot reflect quiz work.

#### PROD-028 — Progress: lesson completion persists — **FAIL · P1**
`upsertLessonProgress` has no call site outside tests; `completed` is always `false`.

#### PROD-016 — Tournament Learning: ICM computed for the learner — **FAIL · P1**
`icmEquity` / `icmVsChipEv` have **zero consumers**; `LiveCalculation` has no `icm` variant; both
tournament scenarios run on pure chip EV. The ICM mathematics is correct (Reviewer C verified 60/40
for 3:1 with 70/30 by hand and by full permutation enumeration) but never reaches a learner.

#### PROD-009 — Scenario Lab: custom scenarios — **FAIL · P1**
No custom-scenario capability. `POST /math/coach` and `/math/equity` are live but unreachable from
the product.

#### PROD-040 — Every registered API route is reachable from the product — **FAIL · P2**
Nine registered routes are unreachable. The contract test only checks the direction that cannot
detect this (that every used path is registered, not that every registered path is used).

#### PROD-015 — Tournament Learning: content exists — **PARTIAL · P2**
Tournament content and mathematics exist; there is no tournament *flow*.

#### PROD-021 — Coach suggestion: size range + confidence + reason + what would change it — **PARTIAL · P3**
All four fields are present and the confidence level is genuinely allowed to be “low”, but the
**size range collapses to a single number in 20 of 29 cases**.

#### PROD-027 — Progress: quiz/scenario/hand progress persists — **PARTIAL · P2**
Progress persists in the database, but two of its four figures can never be non-zero (consequences
of PROD-004 and PROD-028) and **none is displayed**.

#### PROD-030 — Guardrails: units are free, resettable and valueless — **PARTIAL · P2**
Units are genuinely free and valueless, and no purchase, cash-out, transfer or prize path exists.
But **every page states progress can be reset “at any time” and there is no reset control** — the
endpoint works but is absent from `API_PATHS`. A stated user right is not exercisable.

### 5.2 Poker engine (Reviewer B)

#### ENG-023 — A newcomer must post or wait for the big blind — **FAIL · P1**
- **Runtime evidence:** nothing tracks blind obligations. Brute-forcing 15 seating combinations,
  **4 gave the newcomer a completely free hand, twice on the button.** Standing up as the blinds
  approach and sitting back down is unpunished.
- **Test covering it:** none. **Missing work:** track blind obligations per player per room.

#### ENG-001 — Button/blind movement between hands, including dead button — **PARTIAL · P1**
- **Implementation location:** `apps/api/src/rooms/table.ts:894-901`.
- **Runtime evidence:** the button advances one occupied seat and blinds are derived as button+1/+2
  among whoever is seated *now* — there is no dead-button rule. Over 40 hands with a scripted
  join/leave schedule, **6 players paid the big blind twice in a row and 1 skipped it entirely**; a
  doubly-charged player pays `2×BB` where the rules charge `BB + SB`. Minimal repro: seats 0/1/3;
  hand 1 `BTN 1 / SB 3 / BB 0`; seat 2 joins; hand 2 `BTN 2 / SB 3 / BB 0` — seat 0 pays again.
- **Test covering it:** **none — no test in the repo varies the roster between hands.** Reviewer B
  identifies this as the single genuine coverage hole in the engine.
- **Reviewer notes:** no chips are created or destroyed; this is a fairness defect, not an integrity
  one.

#### ENG-021 — The claimed exhaustive evaluation and 20,000-hand soak — **PARTIAL · P2**
The exhaustive test is **real and passed**: 133,784,560 hands in 7.6 s, 2/2, against correct
published frequencies. But `docs/REPORT.md:117` claims a *“20,000 hands / 167,987 decision points”*
**engine** soak; the engine's soaks actually total **8,500** (4,000 + 1,500 + 3,000), and the only
`20_000` in the tree is a seed-collision check in `poker-ai`. **Documentation overclaims evidence.**

#### ENG-015 — Hand cancellation and chip return — **PARTIAL · P2**
Cancellation paths are incompletely specified and incompletely covered; see
`raw/agent-b-engine.md` for the per-case detail.

#### ENG-012 — Showdown ordering — **PARTIAL · P3**
Winner determination itself is **correct**. Ordering and presentation are not: there is no mucking
(every live hand is revealed at showdown), `showdowns` are emitted in seat order rather than
showdown order, and uncalled bets are reported as a one-player “pot” and “award”.

### 5.3 Poker mathematics (Reviewer C)

#### MATH-013 — Offline fixtures the web app renders when the API is down — **FAIL · P0**
Four wrong learner-visible numbers. Same defect as PROD-025, found independently:

| Location | Ships | Truth |
|---|---|---|
| `fixtures/scenarios.ts:959` | rule of 2 and 4 = **160 %** | engine returns `null` |
| `fixtures/scenarios.ts:1001` | `EV(check) = 0`, *“worth the same as folding right now”* | **180.62 chips** — the exact fallacy `evOfCheck` was rewritten to kill |
| `fixtures/review.ts:450` | a **60 %** draw | **32 %** — a 28-point overstatement |
| `fixtures/scenarios.ts:618` | error direction “understates by 2.4” | actually **overstates** by 1.0 |

Triggered whenever the API returns a transport error **or any 5xx**. **Missing work:** regenerate.

#### MATH-012 — Content ↔ maths consistency across 36 scenarios and 24 quizzes — **PARTIAL · P1**
All 36 formal `expectedInsight` claims pass and **all 24 numeric quiz answers are correct**. But two
scenarios grade their own taught answer as not defensible (see PROD-026), and the Coach headlines
`raise` in **30 of 36** scenarios, overriding lessons whose subject is that the price is wrong.

### 5.4 Security (Reviewer D)

#### SEC-026 — OIDC authentication flow — **UNVERIFIED · P3**
The audited instance is guest-only (`oidcEnabled:false`) and no identity provider was available to
drive start→callback. Code reads as strong (state double-submit, PKCE-hash-before-code-spend,
single-use attempts) but **this is explicitly not marked PASS**. **Missing work:** exercise against
a test IdP.

#### SEC-025 — Web/RSC bundled hidden information — **PARTIAL · P3**
Not exercised at runtime (Reviewer D was restricted to the API port). Static analysis shows
`apps/web` has no direct database access and renders only already-redacted API data.

#### SEC-027 — Timing side-channels on secret comparisons — **PARTIAL · P3**
Code uses `timingSafeEquals` and hash-based token lookup; loopback timing is too noisy to support a
runtime claim.

### 5.5 Supply chain (Reviewer E)

#### SUP-015 — The git/tarball/directory lockfile check must be able to fail — **FAIL · P1**
`scripts/supply-chain/dep-shapes.mjs:50-66`. All six patterns **miss** a git and a directory
resolution written in the format pnpm actually emits — proven **0 / 6 matches**. pnpm writes
`resolution: {...}` inline on one line, defeating four line-anchored patterns, and records git as
`repo: github.com/...` with no `git+ssh://` scheme, defeating the fifth. This is the control the
repo's own threat model names against the campaign's delivery **Pattern B**.

#### SUP-016 — Store-reading checks must not pass while inspecting nothing — **FAIL · P1**
With no `node_modules`, the install-hook scan — the control against delivery **Pattern A** —
reports `✓ dependency-shapes — pass` having examined **zero** packages, silently; the deny-list
prints “installed store: 0” and passes; the IOC store sweep warns but exits 0. Even with a store,
**58 of 162 versions (36 %) are never inspected**. `repo-hygiene.mjs:236` implements the correct
principle (*“a scan of nothing proves nothing”*) — applied to 1 gate of 8.

#### SUP-017 — No dependency name may be exempt from analysis — **FAIL · P1**
`scripts/supply-chain/lib.mjs:171` exempts every `@prl/*` name from deny-list, host, integrity,
release-age, OSV and SBOM coverage. The `@prl` scope is **unclaimed on npm (404)**, `.npmrc` maps it
to the public registry, and pnpm ≥ 10 defaults `link-workspace-packages: false`. One
`"@prl/x": "1.0.0"` specifier pulls a stranger's package with zero gate coverage — textbook
dependency confusion.

#### SUP-007 — Mini Shai-Hulud IOC checks are meaningful — **PARTIAL · P1**
The persistence-artefact sweep reads `<store>/<pkg>@<ver>/`, a directory level pnpm **never
populates** (files live at `.../node_modules/<pkg>/`) — proven both ways. It omits
`.vscode/tasks.json`, which `ioc-scan.mjs`'s **own header names as the reason the gate exists**, and
`.claude/settings.json`; an injected `codeql.yml` only warns.

#### SUP-006 — Denied package families adequate and enforced — **PARTIAL · P2**
10 names + 2 scopes against a ~1,300-**version** campaign; omits `@tanstack/`, `@mistralai/` and
`@opensearch-project/`, which the repo's **own cited sources** name; **no entry can ever occur in
this graph**, making the gate a permanent no-op here.

#### SUP-018 — `--offline` audit must not report success — **PARTIAL · P2**
`audit.mjs --offline` **exits 0** with 2 of 8 gates unrun. `deps:quarantine` consumes that exit code
and overwrites `pnpm-lock.yaml` *before* asking the operator to review the diff.

#### SUP-019 — Claimed self-tests exist; CI/container pinning is gated — **PARTIAL · P2**
`sbom.mjs:9` claims validation in `scripts/supply-chain/sbom.test.mjs`, which **does not exist**.
7 of 8 gates have no test. **No gate enforces CI action SHA pinning or Dockerfile base-image digest
pinning** — both currently correct, held by header comments only. **CI never builds either
Dockerfile**, so the release artefact is the one thing no automated check exercises.

### 5.6 Frontend & accessibility (Reviewer F)

#### A11Y-012 — Live regions for dynamic updates — **PARTIAL · P1**
`/play`'s table-error state (“The table could not be prepared”) has **no `role="alert"` and no
live-region ancestor** (`anyLiveAncestor: false`), while the page's only `role="status"`
simultaneously announces **“Ready to connect.”** A screen-reader user is told the opposite of the
truth on the app's most consequential error path — **WCAG 2.2 SC 4.1.3 (AA) failure**. Fix:
`role="alert"` on `TableStage.tsx:261-268`. Second defect (P2): Coach arrival/refresh is never
announced — `announce()` in `use-live-table.ts:158-183` has no `coach` case;
`ScenarioStage.tsx:395-397` already does this correctly for the identical event.

#### A11Y-001 — Keyboard-only operation of every primary journey — **PARTIAL · P2**
728 focusable elements across 12 routes all accept focus and all render a focus ring, and every
custom key handler works — but **OS-level key injection did not function in this environment**, so
no real Tab keypress was possible. The mandated *“real keyboard traversal”* is **not proven**.
**Missing work:** one Playwright keyboard-traversal test.

#### A11Y-002 — No keyboard trap — **PARTIAL · P2**
Unprovable for the same reason; no structural trap candidate was found by inspection.

#### A11Y-016 — Reduced motion respected — **PARTIAL · P2**
CSS side is airtight (verified `!important` universal backstop in the shipped stylesheet). The three
JS animation drivers (`useCountUp`, `useReveal`, `BootSequence`) were not proven to respect it.

#### A11Y-013 — Form error association — **PARTIAL · P3**
`aria-invalid` is used nowhere; the quiz numeric field and the bet-amount field announce or silently
clamp without marking the field.

#### UX-002 — No interactive control occluded — **PARTIAL · P2**
One occlusion across 9 routes × 3 viewports: on `/play` at 375 px the fixed Coach sheet covers the
primary CTA at the initial scroll position, and no bottom padding is reserved. Recoverable by
scrolling; not a WCAG failure.

#### UX-012 — No console errors/warnings — **PARTIAL · P3**
Two: an expected no-history 404 logged at **error** level, and a React “script tag while rendering”
warning from the pre-paint theme boot script.

### 5.7 Operations (Reviewer G)

#### OPS-010 — Graceful shutdown on SIGTERM — **FAIL · P0**
- **Implementation location:** `apps/api/src/ws/hub.ts:189` (`clientTracking: false`);
  `@fastify/websocket/index.js:217` (`if (server.clients)`); `hub.ts:228` (never-run cleanup).
- **Runtime evidence:** idle **0.145 s / exit 0**; **one idle WebSocket → 10.18 s / exit 1**;
  `docker compose stop api` with one WebSocket → **10.62 s / exit 137 (SIGKILL)**, client dropped on
  close code 1006. One *idle* socket suffices. *Mechanism independently re-verified by the lead
  auditor.*
- **Test covering it:** `apps/api/test/shutdown.test.ts` — **passes 3/3 and contains zero
  WebSockets** (lead auditor: 0 grep matches for `WebSocket|ws://|upgrade`).
- **Reviewer notes:** `docs/RUNBOOK.md:394-397,409-411` states the **opposite** and calls it *“a
  defect and is fixed”*. `docker-compose.yml` sets neither `stop_grace_period` nor
  `SHUTDOWN_GRACE_MS`, so Docker's 10 s equals the app's 10 s and SIGKILL always wins.
- **Missing work:** enable client tracking or close sockets explicitly in `preClose`; add a
  WebSocket case to the shutdown test; set `stop_grace_period` above `SHUTDOWN_GRACE_MS`.

#### OPS-015 — `docs/RUNBOOK.md` works as written for a new operator — **FAIL · P0/P2**
§11.4 backup/restore **produces an unservable database**; §10 states a shutdown behaviour that does
not exist; §10 gives an instruction the repo's own compose file violates; and
`docs/reviews/final-release-report.md`, referenced at `docs/REPORT.md:236` as *“the release
decision”*, **does not exist** (independently confirmed by the lead auditor).

#### OPS-003 — Migrations: ordered, idempotent, status, rollback — **PARTIAL · P1**
Apply, ordering, idempotency and status all verified good (lead auditor reproduced: 2 migrations
from empty with a checksummed ledger). **There is no rollback path at all** — only
`up | status | seed | reset`, `reset` refused in production, no `*.down.sql` — and no stated
roll-forward-only policy in its place.

#### OPS-008 — Persistence; live schema security; least-privilege roles in use — **PARTIAL · P1**
Persistence and `db:verify` pass (lead auditor: 121 columns, 41 indexes, 13 tables checked, “every
documented schema security property holds”). `prl_app` is correctly scoped and **proven to work**
(44/44 smoke as a `prl_api` member; CREATE/TRUNCATE/DROP/DELETE denied). But `.env.example:109`,
`docker-compose.yml` and **both CI database jobs connect as a superuser** — lead auditor confirmed
the live role is `poker` with `rolsuper = t` **and** `rolbypassrls = t`. **Nothing automated ever
exercises the privilege model.**

#### OPS-014 — Restart / recovery mid-hand — **PARTIAL · P2**
Nothing corrupts: hand numbering resumes, stacks restore, redaction holds. But each interrupted hand
leaves a permanent `completed_at IS NULL` row **visible in the learner's own history with null
fields**, with no startup reconciliation. Three accumulated in one audit session.

### 5.8 Test quality (Reviewer H)

#### TEST-001 — The documented root test command passes — **FAIL · P0**
`pnpm run test` → **exit 1**, deterministic across three runs. Not a stale build: H recompiled
`poker-math` to a scratch `--outDir` and the emitted JS was identical to `dist/` bar the sourcemap
line. CI runs this command.

#### TEST-011 — Expected numbers are derived, not copied from the implementation — **FAIL · P0**
The fixture tests are pure self-referential snapshots whose remediation instruction is *“regenerate
the fixture”*. Because `assert.deepEqual` throws on the first mismatch inside its loop, the test
names `flop-flush-draw-price` and **never reaches** the 160 % entry. Re-running the comparison
without aborting: **3 of 6 shipped scenarios mismatch.** The guard built to catch exactly this
(`coach-panel-render.test.ts`, which does render the real component and bans > 100 %) is fed
hand-written literals and never sees the shipped data.

#### TEST-003 — The reachability guard prevents a suite reporting `tests 0` — **FAIL · P1**
The guard is **static only**. H defeated it three ways in a scratch copy: a package whose `test`
script is `echo … && exit 0`; a `.test.ts` with zero `test()` calls; and `describe(…, {skip})`. All
pass the guard while node reports `tests 0 / skipped 0` and exits 0. (Positive controls — orphan
file, empty test dir — do fail it correctly.)

#### TEST-005 — The documented no-database waiver produces a green run — **FAIL · P1**
`pnpm run test:no-database` **has never worked**: `shutdown.test.ts` spawns a server that exits 78
without `DATABASE_URL` and has no `databaseSkip` guard.

#### TEST-010 — No mock-only success paths in “integration” tests — **FAIL · P1**
**457 of 534 “integration” tests (86 %) never touch Postgres.** `postgresRoomStore`
(`registry.ts:264`) and `postgresArchive` (`registry.ts:137-197`) have **zero coverage** — nothing
plays a hand at a live table and reads it back from the database. Only 11 of 1,282 tests use a real
socket.

#### TEST-020 — Critical module coverage: migrations & DB tooling — **FAIL · P1**
`migrate.mjs` (28 KB) and `verify-schema.mjs` have **no tests at all**.

#### TEST-021 — Critical module coverage: web client — **FAIL · P1**
`apps/web` coverage loads **2 of ~63 source files**; 118 of 123 exports are never named in a test;
there are **zero render tests**.

#### TEST-022 — Critical module coverage: UI components — **FAIL · P2**
**1 of 21 UI components** is ever rendered; the quoted 99.08 % covers only pure-function files.

#### TEST-023 — Critical module coverage: release-gating scripts — **FAIL · P2**
**12 of 13 supply-chain gate scripts are untested** — and that gate job blocks all of CI.

#### TEST-006 — The suite reports what it executes — **FAIL · P2**
With the database absent, **77 tests do not run and the summary prints `skipped 1`**.

#### TEST-002 — No disabled/skipped/todo tests — **PARTIAL · P2**
Genuinely clean of `.skip`/`.todo`/`xit`, and all database gating goes through one helper — good
practice. But the repo documents “57 DB tests”; the real figure is **77**.

#### TEST-009 — No weak or vacuous assertions — **PARTIAL · P2**
15 of 78 files are static source-text scans rather than behavioural tests; `contracts` shows 100 %
line coverage but **8.11 % function coverage**.

#### TEST-017 — Critical module coverage: auth/session — **PARTIAL · P1**
100 % line coverage, but tested against an in-memory `Map` with no fake/SQL conformance suite — so
the real persistence path is unproven.

#### TEST-019 — Critical module coverage: WebSocket hub + live rooms — **PARTIAL · P1**
Protocol is covered; persistence is not (`registry.ts` 54.79 % function coverage).

#### TEST-025 — Named negative/failure-mode cases for critical logic — **PARTIAL · P2**
`pots.ts:80-88`, the full-refund branch, is **never executed**.

#### TEST-026 — No flaky timing assumptions — **PARTIAL · P2**
No flakiness was observed (unit+integration+scripts run **3× byte-identical**), but
`shutdown.test.ts` carries a 1,500 ms wall-clock budget that is a future flake risk.

### 5.9 Lead auditor

#### LEAD-007 — The project is under version control — **FAIL · P2**
- **Runtime evidence:** `git rev-parse --is-inside-work-tree` → *fatal: not a git repository*; no
  `.git` directory exists anywhere in the tree.
- **Reviewer notes:** there is no commit history, no tags, and no provenance for the audited tree.
  A literal “clean checkout” — required by the release procedure and by this audit brief — **cannot
  be performed**; Reviewer G approximated it by copying the source tree. Two GitHub Actions
  workflows exist and reference a repository that does not exist locally, so neither has ever run
  against this tree. `.gitignore` is present and correct, indicating VCS was intended.
- **Missing work:** initialise version control and run the CI workflows at least once before
  release.

---

## 6. The 143 PASS requirements — what earned them

Per-requirement nine-field records are in the raw reports. Summarised here is the evidence that
justified PASS, because a PASS granted on weak evidence is the failure mode this audit exists to
prevent.

| Block | PASS | The evidence that earned it |
|---|---:|---|
| **Poker engine** (ENG) | 18 | Reviewer B wrote its own probes and **mutation-tested them against two deliberately broken engine copies** (odd chip dropped; `reopens = raisedBetLevel` + heads-up button posting the BB) — both caught, so green is not vacuous. 396 hand-derived assertions; a 50,000-hand soak (275,112 actions, 290,644 rejected illegal actions) checking invariants **after every action**; a 20,000-hand differential (145,631 decision points) against an independently written reopening model. Heads-up ordering, incomplete all-in non-reopening, four-way side pots (sizes **and** eligible sets), odd chips, side-pot-only ties, chip conservation, unbiased `unbiasedInt` (no off-by-one), `Math.random` absent from all 301 source files. Exhaustive: **133,784,560 hands in 7.6 s, 2/2**. |
| **Mathematics** (MATH) | 11 | Reviewer C wrote its **own** evaluator, board enumerator and permutation ICM. AA vs KK = 82.6366 % matched its own 1,712,304-board enumeration bit-for-bit; 0 evaluator mismatches over 40,000 random 7-card pairs; EV(call) **exactly 0.000e+0** at break-even; fold equity round-trips to 1e-15; Monte Carlo CI z = 1.96 verified with 191/200 coverage; ICM 60/40 confirmed by hand *and* by enumeration. **The prior raise-EV P0 is confirmed genuinely fixed.** |
| **Security** (SEC) | 25 | Reviewer D attacked a live instance with clients it wrote itself. The hidden-information objective **holds**: no hole cards, undealt deck or RNG salts obtainable through REST, any WS frame type, errors, hand review, logs, reconnect or seat reuse. Merkle reveal proves **only** board + shown hands (verified in showdown, fold-out and 3-handed mixed cases). Session forge/tamper/fixation/replay, CSRF, WS Origin (foreign/missing/null/empty/lookalike/wrong-port → 4406), SQLi, prototype pollution, oversized/NaN/negative, rate-limit bypass via `X-Forwarded-For`, idempotency replay, stale/future sequences, and concurrent-action races (chips conserved 400 → 400) — all repelled. |
| **Frontend & a11y** (UX, A11Y) | 24 | Reviewer F drove real Chrome with a **self-validating** focus harness and verified its own iframe viewport fidelity. Card accessibility from a **live server-dealt hand**: `"five of clubs"`, `"eight of hearts"`, `"face-down card"` ×10, grouped by `<figure>`/`<figcaption>`. 728 focusable elements: 0 unreachable, 0 without a rendered ring. ~3,400 rendered text nodes × both themes: **0 contrast failures**. Zero horizontal scroll across 9 routes × 3 viewports. Modal trap wraps both directions and Escape restores focus. It also documented **8 false positives it rejected**. |
| **Supply chain** (SUP) | 12 | Reviewer E verified **upstream, not just in format**: the `packageManager` sha256 matches a pnpm tarball it downloaded and hashed; all 3 CI action SHAs match `git ls-remote`; all 3 container digests match Docker Hub. 162 resolved versions, **0 OSV advisories**, **0 lifecycle hooks across all 162** (104 on disk checked directly, the other 58 fetched from the registry). SBOM regenerates **byte-identical** and validates against the real CycloneDX 1.6 schema. |
| **Product** (PROD) | 26 | Reviewer A confirmed the **prior silent-fixture-fallback P0 is genuinely fixed** — API up: `/lab` serves 36 scenarios (fixture has 6), `/review` lists 5 real DB hands; API killed: every screen shows a labelled warning naming the failing path. `rooms_visibility_invite_only` proven to bite on the live database. **No dark patterns** in source or in the rendered bytes of all 11 pages. `CoachSuggestion` has **no field capable of claiming correctness**, and no emitted string does. AI Legends' no-hidden-information guarantee proven by **proxy-instrumented read-set capture**. |
| **Operations** (OPS) | 10 | Reviewer G, from a clean copy: frozen script-disabled install (104 pkgs, cold store, 20 s); boot from `.env.example` with production config validation **exiting 78 with enumerated errors**; readiness genuinely flips to 503 when the DB stops and self-heals; build 13.9 s; **both OCI images build**; container security verified on the *running* container — all five capability sets empty, `NoNewPrivs=1`, read-only rootfs proven by a failed write, non-root uid from `id` inside the container, no secrets in any layer. |
| **Test quality** (TEST) | 10 | Reviewer H: **zero** `.skip`/`.todo`/`xit`, **zero** TODO/FIXME/HACK/XXX, **one** unsafe cast repo-wide, zero mock-call assertions, 353 `assert.throws/rejects`. poker-engine 96.65 % / 86.89 %, poker-math 95.06 % / 83.76 %. The database-availability guard genuinely fails loudly (DB absent → exit 1; waiver + `CI=true` → refused). Unit+integration+scripts run **3× byte-identical**. |
| **Lead** (LEAD) | 7 | See §4. |

### Evidence the lead auditor produced directly

- **Load harness — prior finding R13 (“`test:load` has never worked”) is FIXED**: 3 guest sessions,
  3/3 connections, **5 of 5 hands completed**, 58/57 actions, p99 7.6 ms, **0 errors**.
- **Strict smoke test — 44 checks pass**, including “no socket frame carried a deck, cursor or salt”
  across 37 live frames, hand-history isolation between two users, invite-only enforcement returning
  **404 not 403**, and “progress carries no score, streak, level or rank”.
- **`db:verify` on a freshly migrated database**: 121 columns, 41 indexes, 13 tables checked —
  “every documented schema security property holds”.
- **Migrations from empty** and **idempotent seed**, both clean.
- **Unit suite**: 741 pass / 0 fail across seven packages.

---

## 7. Requirements that could not be verified

| Requirement | Status | Why |
|---|---|---|
| SEC-026 OIDC authentication flow | **UNVERIFIED** | No identity provider available; instance is guest-only |
| A11Y-001 / A11Y-002 real keyboard traversal | **PARTIAL** (component proven, Tab sequencing **not proven**) | OS-level key injection did not function; no real Tab keypress was possible |
| Browser-driven E2E suite | **absent** | None exists in the repo; `test:a11y` is a static audit of server-rendered HTML |
| Production capacity | **N/A** | The load harness is a loopback dev-database regression check and says so itself |
| Deck **fairness** (as opposed to commitment) | **N/A** | Out of scope by design and accurately disclosed: the commitment proves the deck was fixed before any action, not that it was chosen honestly |

None of these was recorded as PASS.

---

## 8. Final challenger — new requirements raised

The challenger ran **after** all eight reviewers, under a strict information wall: it did not open,
list or grep anything under `docs/audit/**` or `docs/reviews/**` before writing its report, and it
stated so explicitly. It independently reproduced the four highest-severity defects (Coach legality,
grader contradiction, wrong shipped figures, red release gate) by its own routes, which is
independent confirmation rather than repetition.

It also raised three requirements no reviewer had stated. All three are **FAIL**.

#### CHAL-A — The accessibility gate is part of the release gate — **FAIL · P2**
- **Exact requirement:** accessibility is a *functional* requirement (workflow scripts:
  “ACCESSIBILITY — WCAG 2.2 AA, a functional requirement”), so its check must gate the release.
- **Runtime evidence:** lead auditor confirmed directly from `package.json` —
  `verify = security:audit && security:hygiene && lint && build && typecheck && design:contrast &&
  test && db:verify`. **`test:a11y` is absent.** It lives only in `test:all`, which is not the gate.
  The challenger further measured that `a11y-audit.mjs` covers **6 routes with 0 violations**, but
  audits *static server-rendered markup of index pages only*.
- **Reviewer notes:** combined with the absence of any browser-driven E2E suite, WCAG 2.2 AA is
  **not gated and not fully verified** — consistent with Reviewer F, which could prove component-level
  accessibility but not real Tab traversal.
- **Missing work:** add `test:a11y` to `verify`; add one browser keyboard-traversal test.

#### CHAL-B — `pnpm run test` is hermetic — **FAIL · P2**
- **Runtime evidence:** the workspace `dist/` directories are load-bearing for the test run **and are
  `.gitignore`d**. A fresh checkout therefore cannot run the suite without a prior `build`, and the
  suite's result depends on build artefacts that are not part of the audited source.
- **Reviewer notes:** this is why `build` precedes `typecheck` in `verify`, which the repo documents —
  but the consequence for test hermeticity is not documented.

#### CHAL-C — Release-gate tests are deterministic — **FAIL · P2**
- **Exact requirement:** a release gate must distinguish a regression from noise.
- **Runtime evidence — and a resolved disagreement between reviewers:**
  - Reviewer H ran unit+integration+scripts **3× with byte-identical results** and reported no flakiness.
  - The challenger observed `apps/api/test/ws-socket.test.ts:851` (*“sits, plays to completion against a
    bot”*) fail **2 out of 2** full-suite runs with `no stack changed across the hand: [1000,1000]`,
    while passing 8/8 when the file was run alone.
  - The lead auditor then ran the integration suite **four more times** after stopping every leftover
    auditor server: **3 clean runs and 1 run with a deliberately competing API instance on the shared
    development database**. All four produced **exactly 2 failures** (the two stale-fixture tests) and
    `ws-socket.test.ts` **passed every time**.
- **Resolution:** the hypothesis that a competing database writer causes it was tested and **did not
  reproduce**. Across 8 observed full-suite runs the test failed in 2 (both by the challenger, on a
  heavily loaded machine — load average above 8) and passed in 6. The assertion is that a bot's stack
  changed during a hand, so the plausible mechanism is a **timing/load sensitivity**: under contention
  the bot does not act before the assertion.
- **Conclusion:** this is an **intermittent failure in a release-gating test**. The audit's own rule is
  that intermittent failures are never to be ignored, so it is recorded as a real defect even though
  the lead auditor could not reproduce it. It revises Reviewer H's “no flakiness observed”, whose three
  runs simply did not hit it, and it refines the challenger's “order-dependent” diagnosis, which the
  file-alone-versus-suite comparison does not by itself establish.
- **Missing work:** make the bot-action wait deterministic (injectable clock or explicit await of the
  bot's action) rather than dependent on wall-clock timing.

### Deterministic baseline established by the lead auditor

After stopping all leftover auditor processes, three consecutive clean runs of the integration suite
gave identical results:

```
run1 exit=1 -> ℹ tests 534  ℹ pass 532  ℹ fail 2
run2 exit=1 -> ℹ tests 534  ℹ pass 532  ℹ fail 2
run3 exit=1 -> ℹ tests 534  ℹ pass 532  ℹ fail 2
   ✖ matches buildCoachReport for every bundled scenario
   ✖ REVIEW_HAND_SHOWDOWN replays and analyses identically
```

**The two real, deterministic failures are both the stale-fixture defect.** That is the finding of
record; the intermittent third failure is a separate, additional defect.
