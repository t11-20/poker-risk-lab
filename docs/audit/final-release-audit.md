# Final Release Audit — Poker Risk Lab

**Audit date:** 2026-08-18
**Auditor:** independent principal release auditor
**Method:** eight independent reviewers (A–H) run in parallel under a single barrier, none able to
see another's conclusions before forming its own; then one final challenger run afterwards under a
strict information wall, tasked with disproving the product. All ran the same model at the same
effort. The lead auditor independently re-verified every P0 rather than relaying it.

---

# RELEASE VERDICT: **FAIL**

**Do not ship.**

Under the stated release rules, `RELEASE: FAIL` follows if **any** P0 or P1 exists, or if any
mandatory requirement is FAIL or UNVERIFIED. This build has **4 confirmed P0 clusters** and **17 P1
clusters**, and its own declared release gate exits 1. The verdict is not close, and it does not
rest on judgement: `pnpm run test` returns exit code 1 deterministically, three times out of three,
in a clean environment.

---

## 1. Requirement counts

Derived mechanically from the reviewers' own status tables — not from their prose summaries, three
of which were off by one against their own tables and have been corrected.

| Status | Count |
|---|---:|
| **Total requirements** | **208** |
| **PASS** | **143** |
| **PARTIAL** | **31** |
| **FAIL** | **33** |
| **UNVERIFIED** | **1** |
| **N/A** | **0** |

*(203 from the eight parallel reviewers and the lead auditor; +3 raised by the final challenger;
+2 added during post-challenger reconciliation — see §11.)*

That is **68.8 % PASS** (143/208). This figure is offered only because the traceability matrix
exists to back it, and it should not be read as “69 % done”: requirements are not equally weighted,
and the four P0 clusters below would block release on their own if every other requirement passed.

Full matrix: [`requirements-traceability.md`](requirements-traceability.md). Per-requirement
nine-field records: [`raw/`](raw/).

---

## 2. What is genuinely good — stated first, because it is load-bearing

An audit that only lists defects misrepresents this codebase. The following were verified at
runtime, adversarially, by reviewers who wrote their own instruments:

- **The rules engine is correct.** Reviewer B mutation-tested its own probes against two
  deliberately broken engine copies before trusting them. Heads-up ordering (button = SB, first
  preflop, last postflop), incomplete all-in raises correctly *not* reopening the action, four-way
  side pots matching hand-computed sizes **and** eligible sets, odd chips, side-pot-only ties, and
  chip conservation after **every one of 275,112 actions** across a 50,000-hand soak. The exhaustive
  test is real: **133,784,560 seven-card hands in 7.6 s** against correct published frequencies.
- **The mathematics is correct.** Reviewer C wrote its own evaluator, board enumerator and
  permutation ICM. AA vs KK matched its own 1,712,304-board enumeration bit-for-bit; EV(call) is
  **exactly zero** at break-even; fold equity round-trips to 1e-15; ICM 60/40 confirmed two ways.
- **The previous round's worst defect is genuinely fixed.** The Coach no longer prices a raise as an
  opening bet; Reviewer C confirmed the residual error term is exactly zero and that 5 recommendations
  would flip back to a wrong `raise` under the old formula.
- **Hidden information holds under attack.** Reviewer D could not extract another player's hole
  cards, the undealt deck, or RNG salts through any channel. The per-card Merkle reveal proves
  **only** the board and hands that actually showed — verified in showdown, fold-out and 3-handed
  mixed cases, with the folder's cards absent.
- **Deck-commitment verification actually works in the browser.** The challenger loaded
  `/review/hand-0042` and saw *“PROVED IN YOUR BROWSER — 9 of 52 deck positions”*, with the client's
  verdict reported independently of the server's. Met, and met in the right spirit.
- **The dependency graph is clean**, verified upstream rather than merely parsed: 162 versions, 0 OSV
  advisories, 0 lifecycle hooks across all 162, `packageManager` hash re-derived from a downloaded
  tarball, all CI action SHAs and container digests matched against upstream.
- **Container security is excellent**, verified on the running container: all five capability sets
  empty, `NoNewPrivs=1`, read-only rootfs proven by a failed write, non-root uid read from `id`
  inside the container.
- **No dark patterns.** Independently scanned in source and in the rendered bytes of every page.
  `CoachSuggestion` has **no field capable of claiming correctness**, and no emitted string does.
  Progress carries no score, streak, level or rank.
- **The `Math.random` ban** is, in the challenger's words, *“the shape every other gate here should
  have”* — a repo-wide scan with a negative-control test that feeds the detector a violation and a
  prose mention and asserts it distinguishes them.

The pattern from the previous review — *“the server is largely real and the client largely is not”* —
has been **partially** addressed. The silent fixture fallback is genuinely fixed: fallbacks are now
labelled on-page and name the failing path. The client's remaining gaps are of a different kind, and
they are enumerated below.

---

## 3. P0 — release catastrophes (4 clusters)

### P0-1 — The Coach prices, publishes, *accepts* and *grades against* actions the learner cannot legally take
`PROD-020` · `CHAL-001` · `CHAL-002` · `CHAL-007` — found by Reviewer A, escalated by the challenger,
mechanism independently confirmed by the lead auditor.

`packages/poker-math/src/coach.ts:153` makes `legalActions` **optional**, and `:556` reads
`input.legalActions === undefined || input.legalActions.includes(action)` — so when the field is
absent, **every action is treated as legal. The guard fails open.**
`apps/api/src/workers/equity-worker.ts:105-120` (`CoachTask`), the wire type used by Scenario Lab,
Hand Review, Legends compare and `POST /math/coach`, **has no field to carry it**. Only the live
table (`ws/router.ts:653`) supplies it.

The consequences compound:

1. **7 of 36 scenarios** recommend an action the learner cannot take, 2 of them as the *headline*
   suggestion at `reasonable` confidence, priced with 35 % fold equity **against a player who cannot
   fold**.
2. The grader then marks the learner wrong **against that fabricated number**: on a scenario whose
   own prose concludes *“folding is better than calling”*, submitting `fold` returns
   `consistentWithAnalysis: false` and tells the learner they are **11,873.7 chips behind**.
3. It **accepts** `{"action":"raise","to":26000}` from a **24,000** stack and replies *“You sized it
   to 26000; the analysis priced 26000.”*

This directly inverts the codebase's own stated design principle (ADR 0003 — build the narrow type
field-by-field *so that it fails closed*), and it breaches guardrail §4, *“never teach something
false.”* The test written to prevent exactly this, `coach-legality.test.ts`, **passes** — because it
hands `legalActions` to `buildCoachReport` itself rather than driving the production wire type.

> The challenger's framing is the correct one: every other report describes this as “the Coach shows
> an illegal option”. That understates it. **The product grades the learner against a fabricated
> number and marks its own lesson wrong.**

### P0-2 — The shipped web fixtures publish provably wrong figures to learners
`PROD-025` · `MATH-013` · `TEST-011` · `CHAL-003` — found **independently by four** reviewers
(A, C, H, challenger) and verified directly by the lead auditor. This is the strongest convergence
in the audit.

Rendered whenever the API returns a transport error **or any 5xx**:

| Location | Ships | Truth today |
|---|---|---|
| `apps/web/src/fixtures/scenarios.ts:959-962` | **“The rule of 2 and 4 estimates 160.0%”** | engine returns `null` |
| `apps/web/src/fixtures/scenarios.ts:1001` | `EV(check) = 0`, *“worth the same as folding right now”* | **180.62 chips** — the exact fallacy `evOfCheck` was rewritten to kill |
| `apps/web/src/fixtures/review.ts:450` | a **60 %** draw | **32 %** — a 28-point overstatement |
| `apps/web/src/fixtures/scenarios.ts:618` | error direction “understates by 2.4” | actually **overstates** by 1.0 |

The **engine was already hardened** against exactly this — `coach.ts:271-278` refuses these cases,
`:375-382` throws outside `0..1`, and its own comment names the bug class (*“a hand with 45 ‘outs’
was 100 % to win and the shortcut called it 180 %”*). Only the fixture was never regenerated;
`CoachPanel.tsx:646-649` renders it unconditionally.

**An application whose entire premise is never being confidently wrong about probability can display
a 160 % probability.** Its own test suite already knows, and has been left red.

### P0-3 — Graceful shutdown is broken for every WebSocket connection
`OPS-010` — Reviewer G; mechanism independently confirmed by the lead auditor.

`apps/api/src/ws/hub.ts:189` sets `clientTracking: false`. `@fastify/websocket`'s `defaultPreClose`
guards on `if (server.clients)` (`index.js:217`), and `ws` only creates that Set when tracking is on
— so the close loop never runs, `app.close()` never resolves, and the grace deadline fires
`process.exit(1)`.

| Condition | Time | Exit |
|---|---:|---|
| idle | 0.145 s | 0 |
| **one idle WebSocket** | 10.18 s | **1** |
| `docker compose stop api` with one WebSocket | 10.62 s | **137 (SIGKILL)**, client dropped on 1006 |

`docs/RUNBOOK.md:394-397,409-411` states the **opposite** and calls it *“a defect and is fixed”*.
`shutdown.test.ts` passes 3/3 and contains **zero WebSockets** (lead auditor: 0 grep matches).
`docker-compose.yml` sets neither `stop_grace_period` nor `SHUTDOWN_GRACE_MS`, so Docker's 10 s
equals the app's 10 s and SIGKILL always wins.

**Every deploy while any learner has a table open is a hard kill** — on the one connection type the
entire product is built on.

### P0-4 — The declared release gate is red, and the release documents do not say so
`TEST-001` · `PROD-039` · `CHAL-004`

```
$ pnpm run test     →  exit 1     (534 tests, 532 pass, 2 fail — 3 clean runs, identical)
$ pnpm run verify   →  exit 1
```

`docs/REPORT.md` presents `pnpm run verify` as the release procedure without recording that it does
not pass. And because `verify` is a `&&` chain with **`db:verify` last**, the gate that
`REPORT.md` §4 describes as asserting *“the **LIVE** schema's security properties”* **has never
executed in the command the documentation tells operators to use.** (It does pass when run directly —
the lead auditor confirmed: 121 columns, 41 indexes, 13 tables checked.)

---

## 4. P1 — required feature broken or missing (17 clusters)

| # | Finding | IDs |
|---:|---|---|
| 1 | **Private multiplayer is unreachable by a user.** The invite code is generated, never displayed, and discarded; `apps/web` contains **zero** references to it and has no join flow. `/play` creates a bot table only. The server side genuinely works (D completed a private hand with two sessions; the lead auditor's load run completed 5/5 hands across 3 sessions) — the client never exposes it. | `PROD-011`, `CHAL-006` |
| 2 | **Tournament Learning (ICM) has no product surface.** `icmEquity`/`icmVsChipEv` have zero consumers; both tournament scenarios run on pure chip EV. The ICM maths is correct and never reaches a learner. | `PROD-016`, `CHAL-005` |
| 3 | **Quiz attempts are never submitted by the web client.** `QuizRunner` grades client-side; `quizAttempt` is the only `API_PATHS` entry with zero call sites. *(The endpoint itself works — the challenger drove it directly and both answers graded correctly. Server real, client not using it.)* | `PROD-004` |
| 4 | **Lesson completion is never persisted.** `upsertLessonProgress` has no call site outside tests; `completed` is always `false`. | `PROD-028` |
| 5 | **No custom scenarios.** `POST /math/coach` and `/math/equity` are live but unreachable from the product. | `PROD-009` |
| 6 | **Teaching content contradicts itself** — two scenarios grade their own taught answer as not defensible. *(Reviewer A rated this P0; Reviewer C rated it P1. The disagreement is recorded, not averaged; it does not change the verdict.)* | `PROD-026`, `MATH-012` |
| 7 | **No dead-button rule.** Over 40 hands with a join/leave schedule, **6 players paid the big blind twice in a row and 1 skipped it entirely**. No test in the repo varies the roster between hands. | `ENG-001` |
| 8 | **No blind-posting obligation for newcomers** — 4 of 15 seating combinations gave a free hand, twice on the button. | `ENG-023` |
| 9 | **Two supply-chain gates aimed at the campaign's two documented delivery mechanisms cannot fire.** The git/tarball lockfile check misses pnpm's real output format (**0/6 patterns match**); the install-hook scan reports a clean pass over **zero** packages. | `SUP-015`, `SUP-016` |
| 10 | **Dependency-confusion exposure.** `lib.mjs:171` exempts every `@prl/*` name from all analysis while the `@prl` scope is **unclaimed on npm (404)** and `.npmrc` maps it to the public registry. | `SUP-017` |
| 11 | **The IOC persistence sweep reads a directory level pnpm never populates**, and omits the artefact its own header names as the gate's reason to exist. | `SUP-007` |
| 12 | **The `/play` error state is invisible to screen readers and contradicted by the only live region**, which simultaneously announces “Ready to connect.” WCAG 2.2 SC 4.1.3 (AA) failure on the most consequential error path. | `A11Y-012` |
| 13 | **No migration rollback path at all** — `up\|status\|seed\|reset` only, no `*.down.sql`, and no stated roll-forward-only policy in its place. | `OPS-003` |
| 14 | **The least-privilege database model is never exercised.** `prl_app` is correctly scoped and proven to work, but `.env.example`, compose and **both CI database jobs** connect as a superuser (`rolsuper = t`, `rolbypassrls = t`). | `OPS-008` |
| 15 | **The test-reachability guard is defeatable three ways** — an `echo && exit 0` test script, a `.test.ts` with no `test()` calls, and `describe(…, {skip})` all pass it while node reports `tests 0`. | `TEST-003` |
| 16 | **86 % of “integration” tests never touch Postgres** (457/534). `postgresRoomStore` and `postgresArchive` have **zero** coverage; only 11 of 1,282 tests use a real socket. `test:no-database` has never worked. Migrations, the web client, and 12 of 13 release-gating scripts have no tests. | `TEST-010`, `TEST-005`, `TEST-017`, `TEST-019`, `TEST-020`, `TEST-021` |
| 17 | **`coach-legality.test.ts` is a gate that cannot fail for the path it was written for.** | `CHAL-007` |

---

## 5. P2 — significant quality gaps (selected)

- The Coach headlines `raise` in **30 of 36** scenarios, overriding lessons whose subject is that the
  price is wrong (`MATH-012`).
- **An intermittent failure in a release-gating test.** `ws-socket.test.ts:851` failed 2/2 for the
  challenger under heavy load and passed in 6 other observed runs (H ×3, lead auditor ×4 including one
  with a deliberately competing database writer). The competing-writer hypothesis was tested and did
  **not** reproduce, so the mechanism is load/timing sensitivity. Recorded as a real defect because
  intermittent failures are never to be ignored (`CHAL-C`).
- **`test:a11y` is not in the `verify` gate**, and the a11y audit covers 6 index pages of static
  server-rendered markup. With no browser-driven E2E suite, **WCAG 2.2 AA is not gated** (`CHAL-A`).
- **`pnpm run test` is not hermetic** — the workspace `dist/` is load-bearing and `.gitignore`d
  (`CHAL-B`).
- Deny-list is a permanent no-op on this graph and omits families the repo's own sources name;
  `audit.mjs --offline` exits 0 with 2/8 gates unrun while `deps:quarantine` consumes that exit code
  and rewrites the lockfile before review; `sbom.mjs:9` claims a test file that does not exist; no
  gate enforces CI SHA or base-image digest pinning; **CI never builds either Dockerfile**
  (`SUP-006`, `SUP-018`, `SUP-019`).
- Interrupted hands leave permanent `completed_at IS NULL` orphans visible in the learner's own
  history (`OPS-014`).
- Every page states progress can be reset “at any time”; **there is no reset control** (`PROD-030`).
- Coach arrival is never announced to screen readers; `/play` mobile hides the primary CTA behind the
  fixed Coach sheet (`A11Y-012`, `UX-002`).
- **The project is not under version control** — no `.git`, no history, no provenance; a literal clean
  checkout is impossible and the two CI workflows have never run against this tree (`LEAD-007`).
- **Documentation overclaims evidence:** `REPORT.md:117` claims a 20,000-hand engine soak where the
  engine's soaks total 8,500; “6 of 35 scenarios” where there are 36; “8 source trees” where the scan
  says seven; the `verify` description omits `design:contrast` and `db:verify`; and
  `docs/reviews/final-release-report.md`, cited as *“the release decision”*, **does not exist**
  (`ENG-021`, `CHAL-012`, `OPS-015`).
- `docs/RUNBOOK.md` §11.4 backup/restore **produces an unservable database** (`OPS-015`).

## 6. P3 — polish

Roughly 30 items, enumerated in the raw reports: `aria-invalid` unused; two console errors; a 404
returned instead of “temporarily unavailable” during an outage; no mucking at showdown; showdowns in
seat order; `describeScore` omitting the deciding kicker; SBOM licence metadata; and the remainder in
[`ux-accessibility.md`](ux-accessibility.md) §3 and [`poker-correctness.md`](poker-correctness.md) §5.

---

## 7. Requirements that are FAIL, PARTIAL or UNVERIFIED

All 65 are listed with full nine-field records in
[`requirements-traceability.md`](requirements-traceability.md) §5 and §8, and in §11.3 of this
document:

- **FAIL (33):** `PROD-004, 009, 011, 016, 020, 025, 026, 028, 039, 040` · `ENG-023` · `MATH-013` ·
  `SUP-015, 016, 017` · `OPS-010, 015` · `TEST-001, 003, 005, 006, 010, 011, 020, 021, 022, 023` ·
  `LEAD-007`, `LEAD-009` · `CHAL-A, B, C, D`
- **PARTIAL (31):** `PROD-015, 021, 027, 030` · `ENG-001, 012, 015, 021` · `MATH-012` ·
  `SEC-025, 027` · `SUP-006, 007, 018, 019` · `UX-002, 012` ·
  `A11Y-001, 002, 012, 013, 016` · `OPS-003, 008, 014` · `TEST-002, 009, 017, 019, 025, 026`
- **UNVERIFIED (1):** `SEC-026` — OIDC flow; no identity provider available. **Not** marked PASS.

Additionally, one mandated verification could not be performed: **real keyboard traversal**.
The two requirements concerned (`A11Y-001`, `A11Y-002`) are already counted as PARTIAL above and are
**not** additional UNVERIFIED entries. OS-level key injection did not function in this environment,
so no real Tab keypress was possible. 728 focusable elements were confirmed to accept focus and render a focus ring,
but the browser's own sequential-focus behaviour is **unproven**, and is reported as such rather than
assumed.

---

## 8. Release-rule application

| Rule | Status |
|---|---|
| Every mandatory requirement PASS | **NO** — 31 FAIL, 31 PARTIAL, 1 UNVERIFIED |
| Zero unresolved P0/P1 | **NO** — 4 P0 clusters, 17 P1 clusters |
| Complete clean release suite passes | **NO** — `pnpm run test` and `pnpm run verify` exit 1 |
| Security / supply-chain gates pass | **PARTIALLY** — the graph is clean and `security:audit` exits 0, but 4 of its 8 gates cannot fail, so the green result overstates what was verified |
| Final challenger finds no P0/P1 | **NO** — the challenger independently found 4 P0 and 4 P1, two of which no other reviewer found |

## **RELEASE: FAIL**

---

## 9. What would change the verdict

In order of leverage:

1. **Regenerate the web fixtures from the engine** and make the existing guard release-blocking.
   This closes P0-2 and turns the gate green. Do not hand-edit — hand-editing produced the drift.
2. **Make `legalActions` a required field** on `CoachTask` and every Coach entry point, or default to
   refusing aggression rather than permitting it. Rewrite `coach-legality.test.ts` to drive the
   production wire type. Then re-derive every shipped scenario's recommendation. This closes P0-1,
   and the grader defect with it.
3. **Enable WebSocket client tracking** (or close sockets explicitly in `preClose`), add a WebSocket
   case to `shutdown.test.ts`, and set `stop_grace_period` above `SHUTDOWN_GRACE_MS`. Closes P0-3.
4. **Correct the release documents** to state what actually runs and what actually passed, and either
   write or remove the referenced release-decision document. Move `db:verify` and `test:a11y` so they
   cannot be skipped by an earlier failure. Closes P0-4.
5. **Build the client surfaces that already have working servers** — invite-code display and join,
   quiz-attempt submission, lesson-completion write, an ICM surface, and a progress reset control.
   Closes five P1s and materially changes what the product *is*.
6. **Give the four vacuous supply-chain gates negative controls**, using `repo-hygiene.mjs` and the
   `Math.random` ban as the model — both already demonstrate the correct pattern in this repo.
7. **Initialise version control** and run the CI workflows against the tree at least once.

Items 1–4 are mechanical and well-understood. Item 5 is genuine product work. None of the four P0s
is in the engine or the mathematics — those are the parts of this system that are demonstrably
right, and they are the reason the rest is worth finishing.

---

## 10. A note on the evidence base

The original `/goal` prompt is **not recoverable** — the implementing session's transcript has been
deleted. The acceptance contract was reconstructed from five surviving sources and is documented in
[`requirements-traceability.md`](requirements-traceability.md) §0. Where a requirement's exact
original wording is unknown, the strictest reasonable reading was applied; no requirement was
narrowed to make it passable.

Nothing in this audit was graded PASS on the existence of a file, a type, a document or a test. Where
something could not be tested, it is marked UNVERIFIED. Two reviewers' prose counts and one reviewer's
summary block disagreed with their own status tables; the tables were taken as authoritative and the
corrections are recorded. One inter-reviewer disagreement (test flakiness) was resolved by further
measurement rather than by averaging, and the resolution is documented in full.

---

## 11. Post-challenger reconciliation

The challenger re-examined its own report after the information wall lifted, and the lead auditor
independently tested its three unique claims. This section records what changed, because an audit
that quietly absorbs a challenger's findings without testing them is doing the same thing it
criticises.

### 11.1 The challenger corrected itself, and its corrections match the lead auditor's measurements

- It had reported `pnpm run test` as **fail 3**; on re-running with its own servers stopped it
  measured **534 / 532 / fail 2, exit 1** and withdrew the third failure. This matches the lead
  auditor's four runs exactly.
- It re-diagnosed `ws-socket.test.ts:851` from *order-dependent* to **load-sensitive** (a race between
  hand settlement and the next deal) and downgraded it P1 → P2 — the same conclusion the lead auditor
  reached independently in §7 of `runtime-verification.md`.
- It withdrew two paths from its multiplayer finding (sit/leave are socket-based by design). The
  core finding stands: `grep -rn "inviteCode" apps/web/src` → **zero matches**.
- It downgraded its own Learn PASS after confirming `quizAttempt` has zero call sites in
  `apps/web/src`, independently corroborating `PROD-004`.

Its final tally: **12 findings — 4 P0, 3 P1, 4 P2, 1 P3.**

### 11.2 One challenger finding was investigated and **rejected**

The challenger claimed a second, distinct legality defect — a `heroStack` *total-versus-behind
double-count* — and stated it would **survive** the agreed fix, citing
`rk-high-spr-same-top-pair` shipping “raise to 1455 from a 1400 stack”. It listed this among the
findings that were its alone.

**This is a false positive.** The lead auditor ran the real Coach over all 36 shipped scenarios
(0 errors) and reproduced the surface symptom — 5 scenarios suggest a raise whose total `to` exceeds
the seat's stated `stack`, in every case with `cost` exactly equal to that stack:

```
fl-big-blind-option-limped-pot      raise to=1000  > stack=990    (committed 10,   cost 990)
fl-heads-up-blind-reversal          raise to=1000  > stack=995    (committed 5,    cost 995)
rk-high-spr-same-top-pair           raise to=1455  > stack=1400   (committed 55,   cost 1400)
rk-nine-big-blinds-call-or-fold     raise to=10800 > stack=10000  (committed 800,  cost 10000)
rk-when-survival-outweighs-chip-ev  raise to=26000 > stack=24000  (committed 2000, cost 24000)
```

But `coach.ts:606` computes `maxTo = heroCommittedThisStreet + heroStack`, which is **correct if
`heroStack` means chips *behind***, and the data says it does:

| Scenario | committed + stack | Reading |
|---|---|---|
| `fl-big-blind-option-limped-pot` | 10 + 990 = **1000** | exactly 100 BB — the BB post deducted |
| `fl-heads-up-blind-reversal` | 5 + 995 = **1000** | exactly 100 BB — the SB post deducted |
| `rk-when-survival-outweighs-chip-ev` | 2000 + 24000 = **26000** | exactly 13 BB |

Three exact round starting stacks are conclusive: the author recorded the stack **remaining after
posting**. Each flagged raise therefore costs precisely hero's remaining chips — an all-in, which is
legal. **`CHAL-001(b)` is withdrawn, and the remediation in §9 item 2 is *not* incomplete.**

> This matters beyond one finding. The challenger's report frames this as the defect that survives
> the fix everyone is converging on. Had it been carried into the release report unverified, it would
> have added a phantom P0 and sent the team looking for a bug that does not exist.

### 11.3 Two genuine new findings, added to the matrix

#### CHAL-D — Product claims about how its numbers are produced must be true — **FAIL · P2**
`apps/web/src/components/SiteFooter.tsx:74-78` tells every learner, on **every page**:

> *“Every equity, out, price and expected value is computed from the actual deck when you ask for it.
> **There is no stored odds table anywhere in this product, so there is no table that can be quietly
> wrong.**”*

`apps/web/src/fixtures/*.ts` contains **18 stored `ruleOfThumb` blocks and 21 stored `heroEquity`
values** — stored odds tables — and **four of them are quietly wrong** (P0-2). The product's own
honesty statement is falsified by the defect it disclaims. Found by the challenger; verified
directly by the lead auditor.

#### LEAD-009 — Scenario seat `stack` semantics are defined and applied consistently — **FAIL · P2**
`ScenarioSeat.stack` (`packages/contracts/src/content-types.ts:229`) carries **no documentation** of
whether it means chips behind or total — the ambiguity that produced §11.2. The convention is also
applied **inconsistently in the data**: in `rk-nine-big-blinds-call-or-fold` the small blind's whole
stack is recorded as *both* `stack: 7200` **and** `committedThisStreet: 7200`, while the scenario's
own `facingAction` says *“the small blind moves all in for 7,200, which is their whole stack”* —
so a seat with nothing behind is described to the maths as having 7,200 behind, which feeds
`effectiveStack` and every fold-equity figure derived from it. The same scenario is titled **“Nine
big blinds”** while giving hero 10,000 behind + 800 posted = **13.5 BB**.

This is the same class of defect Reviewer A found from the other direction (3 scenarios where no
opponent has chips behind), and the undocumented field is its root cause.

**Missing work:** document `ScenarioSeat.stack` on the type; add a validator asserting
`stack + committedThisStreet` is internally consistent with the narrated `facingAction`; correct
`rk-nine-big-blinds-call-or-fold`.

### 11.4 Revised counts

| Status | Count |
|---|---:|
| **Total requirements** | **208** |
| **PASS** | **143** |
| **PARTIAL** | **31** |
| **FAIL** | **33** |
| **UNVERIFIED** | **1** |
| **N/A** | **0** |

**The verdict is unchanged: RELEASE: FAIL.** Both new findings are P2; the four P0 clusters and the
red release gate are untouched by this reconciliation.
