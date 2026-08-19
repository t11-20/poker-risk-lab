# Reviewer A — Product & Education (independent re-audit)

- **Reviewer:** A (Product & Education). Did not implement this product.
- **Date:** 2026-08-19
- **HEAD:** `f20bbad` (as assigned)
- **Method:** Source + product contracts + live HTTP/WebSocket against API `127.0.0.1:4101` and web `127.0.0.1:4100`. Postgres read-only. Prior `docs/audit/*` verdicts were not used as evidence.
- **Servers:** API started with `PORT=4101 HOST=127.0.0.1 PUBLIC_WEB_ORIGIN=http://localhost:4100,http://127.0.0.1:4100,… COACH_TIMEOUT_MS=15000`. Web: `PRL_API_ORIGIN=http://127.0.0.1:4101 next dev --port 4100`. Postgres already healthy on `127.0.0.1:5432`.
- **Journey harness:** `/tmp/prl-agent-a-journeys.mjs` → `/tmp/prl-agent-a-evidence.json` (not in-repo).

---

## Executive summary

The teaching core is real and, on the paths this reviewer actually executed, mostly honest.

Seventeen complete lessons cover every named syllabus topic. Ninety glossary terms. Thirty-six authored Scenario Lab spots, each analysed live by the Coach (outs split clean/dirty, equity labelled exact vs sampled with a 95% CI when sampled, pot odds + break-even + whether it clears, EV per legal action with arithmetic, a suggestion that is a size range + confidence + reason + what would change it, assumptions always in the payload and rendered without a toggle). Quizzes grade on the server against computed values, not answer keys. A guest session’s quiz rows, lesson-completion row, scenario attempts, and a finished hand all persist to that user and are isolated from a second guest. Private `invite_only` rooms can be created and joined by code. A heads-up bot hand was dealt, coached, folded, archived, and reviewed with a Merkle commitment root. Guardrails against money, casino dark patterns, public matchmaking, and chat hold in the live schema and on the shipped surfaces.

Three required product claims do not hold as written:

1. **`/learn` does not show a user their own progress** (PROD-028, PROD-038). The index is deliberately the same HTML for every reader and says so. Completion lives on `/record` and on `GET /me/progress` / `GET /content/lessons` *if* a session cookie is forwarded — which `/learn` does not do.
2. **ICM is not computed for the learner** (PROD-016). `icmEquity` / `icmVsChipEv` exist in `@prl/poker-math` and have unit tests. They are not a `LiveCalculation` kind, not a lesson calculator, not a quiz numeric, and not a scenario analysis. The tournament lesson’s live figures are SPR. The ICM scenario states in so many words that the app answers chip EV only.
3. **Scenario attempts are not persistence-honest the way quizzes now are** (PROD-037, partial). Scoring is correct. `ScenarioAttemptResponse` has no `recorded` field. An anonymous POST is 200 with the same shape as a persisted one. The Lab UI then says “the same one it recorded.”

Related quality gaps: web fixtures still embed full `CoachReport` numbers (labelled when used); `formatPercent` will still print `103.0%` on lesson/legend surfaces that do not go through `formatProbability`; opening Learn/Lab does not mint a guest session, so the default reading path does not persist anything until the learner has opened a table.

No P0 (false taught number, hidden-info leak, or a persistence claim on the quiz wire that I could prove). P1s are the missing ICM calculator and `/learn` not showing the learner’s own progress.

---

## Requirement table

| ID | Requirement | Status | Implementation | Test covering it | Runtime evidence | Reviewer | Finding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PROD-001 | Learn syllabus covers every named topic | **PASS** | `packages/contracts/src/content-types.ts` `TOPICS`; 17 lessons in `packages/content/data/lessons/{foundations,decisions}.json` | `packages/content/test/scenarios.test.ts` “content set is substantial”; topics covered asserted | `GET /api/v1/content/lessons` → 17 lessons, topics: rules-and-flow, positions-and-blinds, hand-reading-and-outs, probability-and-equity, pot-odds-and-ev, bet-sizing-and-spr, fold-equity-and-bluffing, ranges, variance-and-bankroll, tournaments. Named list all present as dedicated lessons (see §Lessons). | A | — |
| PROD-002 | Lesson content is real and complete (not placeholders) | **PASS** | Same JSON; each lesson 15–20 blocks, 5–6 takeaways, attached quiz | content validator `packages/content/src/validate.ts`; no `TODO/FIXME/placeholder` in data | All 17 `GET /content/lessons/:id` = 200; `placeholder: null`; quizzes 4–5 questions each | A | — |
| PROD-003 | Quizzes score correctly on the server | **PASS** | `apps/api/src/routes/content.ts` `gradeQuestion` / `expectedValueFor` | `apps/api/test/content-routes.test.ts`; `apps/api/test/y2-quiz-attempt-recording.test.ts` | MC right → `correct: true`; MC wrong → `correct: false`; numeric `pot-odds-q2` value 33.3 → `correct: true`, `expected.value: 33.333…`, `tolerance: 1.5` | A | — |
| PROD-004 | Quiz attempts recorded for the user who took them | **PASS** | `recordQuizAttempt` in `apps/api/src/repositories/progress.ts`; `QuizAttemptResponse.recorded` | `y2-quiz-attempt-recording.test.ts`; `apps/web/test/quiz-attempts.test.ts` | Guest A `recorded: true`; DB 3 rows for `usr_qxwnblqvtz4udfozkc7sz4iflp`; Guest B count 0; anonymous `recorded: false` | A | — |
| PROD-005 | Glossary is real and complete | **PASS** | `packages/content/data/glossary.json` (90 entries) | content stats floor ≥45 terms | `GET /content/glossary` → 90 entries, 19 with formulas; `/learn/glossary` HTML includes ICM definition | A | — |
| PROD-006 | Guided Practice: bots with recognisable styles | **PASS** | `BOT_TABLE` in `apps/web/src/lib/table-rooms.ts`; `LEGACY_PROFILE_IDS` in `apps/api/src/rooms/bots.ts`; 12 legends in `packages/poker-ai/src/profiles.ts` | `apps/api/test/rooms.test.ts` legends; `apps/api/test/bots.test.ts` | `POST /rooms` seated `Patient Technician` (`patient-technician`) and `Calling Station`; play HU used `calling-station`; `/play` copy: “private table against five bots” (TAG×2, calling-station, LAG, nit) | A | — |
| PROD-007 | Guided Practice: a hand can be completed | **PASS** | `apps/api/src/rooms/table.ts` `startHand`; WS `action` | `apps/api/test/ws-socket.test.ts` “sits, plays to completion against a bot” | WS: sit, `startHand`, one fold, `handComplete`; `hand_qxbnc33lkj2o5ssqbgrryew75x` `endedByFold: true`; `prl.hands.completed = true` | A | — |
| PROD-008 | Scenario Lab: authored situations, decide-then-reason | **PASS** | `apps/web/src/app/lab/[scenarioId]/page.tsx` + `ScenarioStage.tsx` (assumptions → table → decision → analysis) | content CLAIMS test | `/lab` HTML: 36 scenarios, filters. `/lab/eq-flush-draw-turn-small-bet`: assumptions panel *before* the decision, no assumptions toggle | A | — |
| PROD-009 | Scenario Lab: custom scenarios | **N/A** | `POST /api/v1/math/coach` exists (`apps/api/src/routes/calc.ts`) but no Lab builder, no “your own spot” UI | — | README / PRODUCT-GUARDRAILS / content-types describe an *authored* lab. Grep of `apps/web/src` for custom-scenario UX: no matches | A | Not a documented original-goal requirement. Ad-hoc Coach is API-only. |
| PROD-010 | Play-Money Tables: create private invite-only table | **PASS** | `POST /rooms` `apps/api/src/routes/rooms.ts`; `CreateRoomResponse.visibility: 'invite_only'` | `apps/api/test/rooms.test.ts` | `201`, `visibility: "invite_only"`, invite code `3YFK-UG4R-GAUU-JK8Q` (invite table) and `HCFH-AJ9R-ST9K-T7MQ` (HU) | A | — |
| PROD-011 | Play-Money Tables: join by invite code | **PASS** | `POST /rooms/join` | rooms tests | Guest B joined with the code → `200`, same `room_id`; bad code `NOTAREALCODE99` → `404 invite_code_invalid`. `/play` HTML has “Join a private table with an invite code” | A | — |
| PROD-012 | Play-Money Tables: play a hand | **PASS** | WS hub `apps/api/src/ws/hub.ts` + table | `ws-socket.test.ts` | Same completed HU hand as PROD-007; chips conserved (`netBySeat` 0/−5 and +5) | A | — |
| PROD-013 | Hand Review: replay decision by decision | **PASS** | `GET /hands/:id` `apps/api/src/routes/hands.ts`; `apps/web/src/components/HandReplay.tsx` | `apps/api/test/hands.test.ts` | Review `200`; `decisions: [{sequence:1, street:preflop, seat:0, action:fold, hasAnalysis:true, candidates:[fold,call,raise…]}]`. Other user → `404 hand_not_found` | A | This hand was a preflop fold, so one decision. Mechanism works. |
| PROD-014 | Hand Review: deck-commitment verification | **PASS** | Merkle `packages/poker-engine` commitment; `HandReviewResponse.verification` | engine commitment tests; hands tests | Event `handStarted.commitmentRoot` = review `commitmentRoot` = `d31d4a84e5d9ff3d8e60dfe31fe5c91bbac76f9d97dbefc88966086cc6cc0f46`. `verification.ok: true`, `verifiedPositions: 0`, reason: nothing became public (fold preflop, empty reveal is the correct proof) | A | Vacuous proof on this hand; root was published and verified. |
| PROD-015 | Tournament Learning: ICM/tournament content exists | **PASS** | Lesson `tournament-chips-and-icm`; quiz `quiz-tournament-chips-and-icm`; scenarios `rk-nine-big-blinds-call-or-fold`, `rk-when-survival-outweighs-chip-ev`; glossary `icm` | content bundle tests | Lesson 19 blocks, quiz 5 questions; `/learn/tournament-chips-and-icm` HTML teaches Malmuth–Harville shape; glossary ICM entry live | A | Content exists. Computation is PROD-016. |
| PROD-016 | Tournament Learning: ICM computed for the learner | **FAIL** | Maths: `packages/poker-math/src/icm.ts` `icmEquity` / `icmVsChipEv`. **Not wired:** `LiveCalculation` has no `icm` kind (`content-types.ts`); lesson live calcs are `spr`; quiz numeric is `potOdds`; scenario analysis is Coach chip-EV | `packages/poker-math/test/icm.test.ts` only | Lesson blocks: two `liveCalculation` both `kind: "spr"`. Scenario assumptions: “Every figure the app computes here is chip expected value. It does not model the value of a finishing position.” No ICM in analysis JSON | A | **P1.** Library exists; the learner never gets an ICM number. |
| PROD-017 | Coach: clean vs dirty outs | **PASS** | `packages/poker-math/src/outs.ts`; `CoachReport.outs`; `CoachPanel.tsx` | math outs tests; `packages/ui/test/coach-panel-render.test.ts` | Flush-draw scenario: `clean:7 dirty:2 total:9` with card lists + explanation. Facing-bet Coach: `clean:7 dirty:8` | A | — |
| PROD-018 | Coach: equity labelled exact vs sampled, 95% CI when sampled | **PASS** | `EquitySummary.method` / `confidenceHalfWidthPoints`; `UncertaintyNote` | coach tests; CoachPanel render test | Exact: `method: exact-enumeration`, `confidenceHalfWidthPoints: null`, uncertainty “no sampling error”. Sampled (live table preflop): `method: monte-carlo`, `ci: 2.052…`, suggestion text “±2.05 points at 95% confidence” | A | — |
| PROD-019 | Coach: pot odds + break-even equity + whether it clears | **PASS** | `PotOddsSummary`; CoachPanel | math odds tests | Facing-bet: `breakEvenEquity: 0.333…`, `oddsRatio: 2`, `equitySurplus: 0.099…`, explanation “You clear that with 43.3% equity, a 9.9 point surplus.” Free call: `oddsRatio: null`, “no price to beat” | A | — |
| PROD-020 | Coach: EV per LEGAL action with arithmetic (illegal not graded as legal) | **PASS** | `buildCandidates` + `deriveLegalActions` in `packages/poker-math/src/coach.ts`; `requirePayableSizing` in content routes | `apps/api/test/coach-legality.test.ts`; `x1-unpayable-sizing.test.ts` | Facing bet: fold/call/raise only. Free check: check/fold/bet (no call). Opponent all-in: fold/call only (no raise). Raise-to-26000 attempt: **400** `to` “500 is your whole stack”. Check-on-bet attempt: 200 `consistentWithAnalysis:false` “check is not one of the actions available… evaluated: fold, call, raise” | A | Fold remains a *legal* action when check is free; it is priced at 0 and the Lab refuses it as dominated. That is legality, not a leak. |
| PROD-021 | Coach: suggestion = size range + confidence + reason + what would change it | **PASS** | `CoachSuggestion` in `packages/contracts/src/api-types.ts` | coach-panel-render test | Live: `{action, sizeRange:{min,max}, confidence: 'low'\|'moderate'\|'reasonable', reason, whatWouldChangeIt: [...]}`. Fold suggestion correctly omits `sizeRange` | A | — |
| PROD-022 | Coach: assumptions always visible, never behind a toggle | **PASS** | `AssumptionList.tsx` (explicitly no `<details>`); CoachPanel “Always visible” | ui tests | Scenario HTML: “What this analysis assumes” / “Read first” before the table; `show assumptions` not present. Report `assumptions.length` 6–9, required non-empty (API refuses empty) | A | EV table / outs cards / teaching notes *are* in `<details>` — allowed. Assumptions are not. |
| PROD-023 | Coach: no field capable of claiming correct/optimal/best | **PASS** | `CoachSuggestion` fields listed above; CoachPanel rule 3 | contract + render tests; runtime `scanForbidden` | Type has no such field. Runtime JSON of Coach reports / review: no `correct play` / `optimal` / `GTO` / `solved`. Panel disclaimer: “not a claim about the best play” | A | Suggestion prose says “highest expected value against the stated range”, which is a comparison, not a “best play” field. |
| PROD-024 | Content integrity: no hard-coded computed number in packages/content | **PASS** | ADR 0006; content stores situations; `expectedInsight` qualitative | `packages/content/test/scenarios.test.ts` CLAIMS | Grep of `packages/content/data/**/*.json` for `\d+%`: **no matches**. No `equityBetween`/`sprBetween` regression locks in the shipped JSON. Live figures come from Coach | A | Situation inputs (pot, stacks, cards) are stored, as ADR 0006 allows. |
| PROD-025 | Content integrity: no hard-coded computed number in web copy/fixtures | **PARTIAL** | Live pages compute. Fallback: `apps/web/src/fixtures/scenarios.ts` `LAB_SCENARIO_ANALYSIS` stores full `CoachReport` numbers (`heroEquity: 0.384…` etc.). Regenerated via `pnpm run fixtures:check` | `fixtures:check` script | `/learn` live, not fixture. `/review` without session **does** render fixture rows and says so (“rows below come from src/fixtures/review.ts”). `/lab` this session served all 36 live | A | **P2.** Fixture path stores computed numbers. Labelled when used; can drift until `fixtures:check`. |
| PROD-026 | Authored teaching point agrees with computed maths | **PASS** | `checkScenarioClaims` in `packages/content/src/scenario-analysis.ts` | `scenarios.test.ts` “CLAIMS: every scenario teaching point is verified against the computed maths” | Flush-draw small-bet: `expectedInsight` equityExceedsBreakEven + callEvSign positive; live `equity 0.268` vs BE `0.147`, call EV +20.55, `consistentWithAnalysis: true` for call | A | Did not re-run the content test binary this session; runtime analysis matches the authored relationship. |
| PROD-027 | Progress: quiz/scenario/hand progress persists | **PASS** | `prl.quiz_attempts`, `scenario_attempts`, `lesson_progress`, `hands` | repositories + content-routes tests | After journeys: 3 quiz rows, 5 scenario attempts, 1 lesson completed, 1 completed hand for Guest A; Guest B empty | A | — |
| PROD-028 | Lesson completion persists AND `/learn` shows THEIR OWN progress | **FAIL** | Persist: `POST /content/lessons/:id/read` + `LessonRead.tsx`. Display: `apps/web/src/app/learn/page.tsx` `completionKnown: false`; `loadLessonList()` forwards no cookie | `apps/web/test/y1-learn-index-honesty.test.ts` (encodes the *non-personalised* choice) | Persist: `completedAt` ISO, DB row, `GET /content/lessons` for Guest A has `hand-flow` completed. `/learn` HTML: “This index is the same for every reader, so it does not know which lessons you have already finished” | A | **P1** against the requirement as written. Progress is on `/record`, not `/learn`. |
| PROD-029 | Guardrails: no money, purchase, cash-out, transfer, prizes, crypto, affiliate | **PASS** | `docs/PRODUCT-GUARDRAILS.md` §1; no transfer routes; schema comment forbids balance columns | schema verify; hygiene | Home HTML: “Not a gambling product… cannot be bought, sold, transferred or cashed out”. Units reset exists, no cashier. DB column scan for wallet/cash/prize/crypto: no such columns (only `expires_at`, `matched_expected`) | A | — |
| PROD-030 | Guardrails: units free / resettable / valueless | **PASS** | `DEFAULT_UNIT_ALLOWANCE=1000`; `POST /me/units/reset`; `<UnitsBadge>` | auth tests | Guest A `units: 1000`. Reset `200` `{units: 2000}` after two tables’ stacks restored. Badge copy on every page: free, no value, resettable | A | 2000 after reset is sum of two live `starting_stack`s (derived model), not a store of value. |
| PROD-031 | Guardrails: no casino dark patterns | **PASS** | Guardrails §2; progress type has no streak/XP; quizzes no pass mark | progress route comments + tests asserting key sets | `/record` HTML: “no score… no streak and no rank”. No autoplay control on `/play`. No leaderboard route | A | — |
| PROD-032 | Guardrails: no public matchmaking, no chat | **PASS** | ADR 0010; rooms always `invite_only`; no chat frames in `ws-protocol.ts` | rooms tests | Create responses `visibility: invite_only`. WS client types: hello/sit/stand/action/requestCoach/startHand/ping — no chat. Grep `apps/api/src` for chat: only invite-code whitespace comment | A | — |
| PROD-033 | `rooms.visibility` CHECK-constrained in the LIVE schema | **PASS** | `db/migrations/0001_initial.sql` `rooms_visibility_invite_only CHECK (visibility = 'invite_only')` | `apps/api/test/coverage-verify-schema.test.ts` | Live: `pg_get_constraintdef` = `CHECK ((visibility = 'invite_only'::text))`. `select distinct visibility from prl.rooms` → `{invite_only}` only | A | — |
| PROD-034 | 30+ authored scenarios | **PASS** | 3 JSON files under `packages/content/data/scenarios/` | content stats `>= 30` | API list: **36**. `/lab` “Every topic (36)” | A | — |
| PROD-035 | 10+ deceptive scenarios (trap common mistakes) | **PASS** | No `deceptive` flag. Pedagogy is `commonMistakes` + paired spots | CLAIMS + commonMistakes required by validator | ≥12 spots designed to trap (listed below). Every scenario has `commonMistakes` | A | Classified from content, not a schema tag. |
| PROD-036 | Responsible-use / not-gambling messaging present and accurate | **PASS** | Home hero, units badge, tournament callout, glossary ICM, onboarding | honesty-claims web tests | Home: “Not a gambling product”, “00 Practice units only · no real money”. Tournament lesson: “Nothing of value is awarded here”. Accurate vs behaviour (no cash-out path) | A | — |
| PROD-037 | `ScenarioAttemptResponse` honest/correct | **PARTIAL** | `packages/contracts/src/api-types.ts` `ScenarioAttemptResponse` has **no `recorded`**. Route stores only if `userId !== null` then always 200 | `x1-unpayable-sizing.test.ts` (scoring); **no** recorded-field test | Scoring: honest (see transcripts). Anonymous POST 200, keys identical to signed-in, `hasRecorded: false` on the type. UI `ScenarioStage.tsx:190`: “the same one it recorded.” DB: no null-user rows | A | **P2.** Quizzes were given `recorded`; scenarios were not. Scoring does not lie. Persistence does. |
| PROD-038 | `/learn` shows a user their own progress | **FAIL** | `apps/web/src/app/learn/page.tsx` lines 151–193; `learn-data.ts` `loadLessonList()` | `y1-learn-index-honesty.test.ts` | `curl http://127.0.0.1:4100/learn`: “same for every reader”; zero “completed”/“progress” marks. Contrast: `GET /content/lessons` *with* Guest A cookie *does* return `completed: true` for `hand-flow` | A | **P1.** Requirement names `/learn`, not `/record`. |
| PROD-039 | Coach legal-action grading only | **PASS** | Same as PROD-020 | `coach-legality.test.ts` “every shipped scenario publishes nothing outside the legal set” | Opponent `opponentStacks:[0]` → candidates fold+call only. Degenerate stacks 0 / toCall 0 → check+fold, **no bet**. Illegal check/raise-to-26000 not priced as consistent | A | — |
| PROD-040 | Impossible probability never shown as a real number | **PARTIAL** | Producer: `assertProbabilityFraction` in coach.ts. Panel: `packages/ui/src/probability.ts` `formatProbability` → `null` / “not a probability”. **Unguarded:** `formatPercent` still used in `learn-calculations.ts`, `LiveCalculation.tsx`, `PostHandComparison.tsx`, legends tables. `format.ts` documents that `formatPercent(1.03)` is `"103.0%"` | `packages/ui/test/probability.test.ts`; `coach-panel-render.test.ts`; `format.test.ts` (`formatPercent(1.03)==='103.0%'`) | Live Coach JSON: all probability fields in 0..1, `scanImpossible: []`. Degenerate report still well-formed (BE 0, oddsRatio null). Did **not** get the API to emit NaN/>1 | A | **P2** defence-in-depth hole on non-Coach surfaces. Coach panel itself is guarded. |
| PROD-041 | Guest → Learn → quiz → progress E2E | **PARTIAL** | Guest: `POST /auth/guest`. Quiz/progress as above. Learn UI does **not** mint a guest (`quiz-attempts.ts` comment: “nothing creates a session until a table is opened”) | y2-quiz-attempt-recording (the anonymous half) | **With explicit guest:** quiz+lesson+progress isolation **works**. **Default Learn UI:** anonymous quiz `recorded: false`, `GET /me/progress` 401, `/learn` blank of personal ticks | A | **P2.** Documented guest-first Learn path does not persist until `/play` has created a session. |
| PROD-042 | Guest → Guided Practice → complete hand | **PASS** | `/play` `LiveTable.tsx` + `use-live-table.ts` | ws-socket journey test | Guest A created HU bot table, WS completed a hand, `handsPlayed` would move after archive (hand row present) | A | — |
| PROD-043 | Scenario Lab → analysis journey | **PASS** | GET scenario (analysis included) + POST attempt + `/lab/:id` | content-routes tests | GET 200 with full Coach analysis; POST call consistent; page shows assumptions then ActionBar then (after commit) CoachPanel | A | — |
| PROD-044 | Poker Table → Coach journey | **PASS** | WS `requestCoach` → `WsCoach` | ws tests / bots | Frame types included `coach`. Report: monte-carlo, CI, 9 assumptions, suggestion `raise` confidence `low`, `forbidden: []` | A | — |
| PROD-045 | Completed hand → Hand Review | **PASS** | `GET /hands`, `GET /hands/:id`; `/review/[handId]` | hands tests | List contains the hand; review 200 with decisions + verification; other guest 404 | A | Web `/review` without session honestly shows **labelled fixtures**. |
| PROD-046 | Tournament learning journey | **PARTIAL** | Lesson + quiz + 2 scenarios exist and load | content tests | `/learn/tournament-chips-and-icm` 200 with real prose + SPR live calcs + quiz. ICM figure is **not** computed (PROD-016) | A | Journey of *reading* works; journey of *computing ICM* does not. |
| PROD-047 | Original content only | **PASS** | Guardrails §7; LICENSE; legends ADR 0011 (styles not people) | impersonation guard at profile load | No Hopkins/Zynga/Upswing/PioSOLVER material in content JSON. Legends default `archetype` names. Starting-hand claims in README are computed, not chart-copied (not re-derived this session) | A | Cannot prove a negative exhaustively; no third-party course/brand reproduction found in teaching data. |
| PROD-048 | *(discovered)* Learn/Lab mint no guest session, so persistence is opt-in via Play | **FAIL** | `apps/web/src/lib/quiz-attempts.ts` header; `POST /auth/guest` is called from the live-table client (`table-rooms.ts` `ensureSession`), not from Learn/Quiz/Lab | y2 anonymous quiz test | Anonymous quiz `recorded:false`; anonymous scenario 200/unpersisted; `/record` without cookie: “There is no session to read a record with” | A | **P2.** Product copy is guest-first; Learn does not create the guest. |

**Counts:** 48 requirements (47 catalog + 1 discovered). **PASS 38 · FAIL 4 · PARTIAL 5 · N/A 1 · UNVERIFIED 0.**

Catalog-only (PROD-001–047): PASS 38 · FAIL 3 · PARTIAL 5 · N/A 1.

---

## Detailed records for every non-PASS

### PROD-009 — N/A (custom scenarios)

README “What it does” describes an authored Scenario Lab, guided bots, and private tables. There is no product-contract requirement to let a learner author a spot. `POST /math/coach` and `POST /math/equity` work (exercised below) and are not linked from `/lab`. Honest classification: **not required, not built as a Lab feature.**

### PROD-016 — FAIL P1 (ICM not computed for the learner)

`LiveCalculation` union (`packages/contracts/src/content-types.ts`) is equity / outs / potOdds / ruleOf24 / callEv / foldEquity / spr / variance / riskOfRuin. No ICM.

Tournament lesson live calculators (runtime `GET /content/lessons/tournament-chips-and-icm`):

```json
{ "kind": "liveCalculation", "calc": "spr" }
{ "kind": "liveCalculation", "calc": "spr" }
```

Quiz `icm-q2` is `potOdds` chip break-even, then MC about the *shape* of ICM. Scenario `rk-when-survival-outweighs-chip-ev` assumption (live GET):

> Every figure the app computes here is chip expected value. It does not model the value of a finishing position, so it answers only half of the question this spot asks.

`packages/poker-math/src/icm.ts` is real (Malmuth–Harville, assumptions named). It is not on any learner surface. The product teaches tournament ICM as prose and then, in the one spot that needs the number, tells the learner the number is missing.

### PROD-025 — PARTIAL P2 (fixtures store computed numbers)

`apps/web/src/fixtures/scenarios.ts` header admits it: every `CoachReport` in `LAB_SCENARIO_ANALYSIS` is stored JSON with `heroEquity`, EVs, intervals. Comment says they were generated at 40k samples / seed 20260817 and `fixtures:check` exists. That is still a hard-coded computed number in the web tree.

Mitigation observed: `/lab` this session was live (36 scenarios). `/review` without a session **did** render fixture hands and labelled the source. The requirement is about the files, not only the happy path.

### PROD-028 / PROD-038 — FAIL P1 (`/learn` is not personalised)

`apps/web/src/app/learn/page.tsx`:

```ts
const lessons = await loadLessonList(); // no session cookie
const curriculum = buildCurriculum(lessons.data.lessons, {
  completionKnown: false,
});
```

Live HTML (`curl http://127.0.0.1:4100/learn`):

> This index is the same for every reader, so it does not know which lessons you have already finished — nothing below is a mark on your record. What you have read is recorded when you press the control at the end of a lesson, and it is counted on your record.

The same user’s `GET /api/v1/content/lessons` **with** session *does* return `completed: true` for `hand-flow`. The API can personalise; the page that the requirement names refuses to ask.

`/record` is the personalised surface, and without a cookie it honestly refuses to invent a zeroed record. That is good design and still not `/learn`.

### PROD-037 — PARTIAL P2 (ScenarioAttemptResponse persistence honesty)

Contract (`packages/contracts/src/api-types.ts`):

```ts
export interface ScenarioAttemptResponse {
  readonly consistentWithAnalysis: boolean;
  readonly reasoning: string;
  readonly analysis: CoachReport;
  readonly commonMistakes: readonly string[];
}
```

No `recorded`. Contrast `QuizAttemptResponse.recorded`, added specifically because a 200 used to look like a write.

Runtime:

| Call | Status | Keys | DB |
| --- | --- | --- | --- |
| Guest A POST call | 200 | consistentWithAnalysis, reasoning, analysis, commonMistakes | row for `usr_qxwn…` |
| Anonymous POST call | 200 | **same keys** | `scenario_attempts where user_id is null` = 0 |
| Invalid id | 404 `content_not_found` | error | — |
| raise to 26000 | 400 field `to` | error | no “consistent: true” lie |

Scoring is correct. Persistence is silent. UI `ScenarioStage.tsx` Verdict when `server.state === 'live'` (any 200):

> This is the server’s own verdict on your action — **the same one it recorded.**

That sentence is true only if a session existed. Quizzes no longer make this mistake.

`matched_expected` was NULL for every attempt this session, including a clearly inconsistent fold, because the analysis also supported raise (`claimsOneAction` false). That NULL is the honest DB encoding, not a scoring lie.

### PROD-040 — PARTIAL P2 (impossible probabilities)

Guarded: CoachPanel (does not even import `formatPercent`), EquityBar, `formatProbability`. Unguarded: `formatPercent(1.03) === "103.0%"` by design in `packages/ui/src/format.ts`, used from lesson calculators and legends tables.

This session’s Coach payloads had no impossible fractions. Degenerate `pot=0, stacks=0` still produced probabilities in 0..1 and refused a bet (opponent cannot answer). SPR prose in that degenerate report said `0 / 1 = 0` while `potTotal` was 0 — a P3 wording fudge, not a >100% probability.

### PROD-041 / PROD-048 — PARTIAL / FAIL P2 (guest Learn path)

`apps/web/src/lib/quiz-attempts.ts`:

> the product’s DEFAULT state, since nothing creates a session until a table is opened

Confirmed: anonymous quiz `recorded: false`; anonymous `/me/progress` 401; `/record` “no session”. Explicit `POST /auth/guest` then quiz/lesson **does** persist and isolates. The journey the requirement names works only if the auditor (or `/play`) mints the guest first.

### PROD-046 — PARTIAL (tournament journey without ICM number)

See PROD-015 (content) + PROD-016 (missing computation).

---

## Deceptive / trap scenarios (PROD-035)

No `deceptive` field. These 14 are spots whose `title` + `commonMistakes` are built to catch a standard mistake (counted toward 10+):

1. `eq-flush-draw-turn-overbet` — same draw as the cheap-bet sibling; price trap.
2. `eq-second-pair-vs-narrow-range` — same hand, range changes the answer.
3. `eq-dominated-flush-draw-turn` — drawing to second-best flush.
4. `eq-reverse-implied-odds-weak-ace`
5. `eq-break-even-equity-and-bet-size` — gutshot vs pot-sized bet.
6. `fl-gutshot-facing-turn-bet`
7. `fl-overcards-dirty-outs` — only one overcard is clean.
8. `fl-combo-draw-already-ahead` — “draw” that is already best.
9. `rk-high-spr-same-top-pair` vs `rk-low-spr-commit-top-pair` — same top pair, depth reverses the line.
10. `rk-a-right-call-that-usually-loses` — +EV that usually loses.
11. `rk-when-survival-outweighs-chip-ev` — +chip-EV call the prose tells you to decline.
12. `rk-the-fold-that-feels-wrong` — fold TPTK.
13. `rk-semi-bluff-raise-on-the-turn` — draw that cannot call.
14. `fl-same-cards-under-the-gun` vs `fl-same-cards-on-the-button` — position trap.

---

## Lessons vs named syllabus (PROD-001)

| Named topic | Lesson id(s) |
| --- | --- |
| rules/flow | `hand-flow`, `betting-actions`, `all-ins-and-side-pots` |
| position/blinds | `position-basics`, `blinds-and-the-option` |
| outs | `reading-the-board`, `counting-outs` |
| equity | `rule-of-2-and-4` |
| pot odds | `pot-odds` |
| EV | `expected-value` |
| fold equity | `fold-equity` |
| bet sizing | `bet-sizing` |
| SPR | `stack-to-pot-ratio` |
| ranges | `ranges-and-combos` |
| variance | `variance` |
| bankroll | `sample-size-and-risk-of-ruin` |
| tournament ICM | `tournament-chips-and-icm` |

`risk-psychology` is a `TOPICS` member with a scenario (`rk-the-fold-that-feels-wrong`) and no dedicated lesson. Not in the named catalog list.

---

## Journey transcripts

All times 2026-08-19T07:19:30Z unless noted. API origin `http://127.0.0.1:4101`. CSRF: `GET /api/v1/auth/session` then `x-csrf-token` + `prl_csrf` cookie + `Origin: http://127.0.0.1:4100`.

### Health

```
GET /api/v1/health → 200 {"status":"ok","version":"0.1.0","protocolVersion":1}
GET /api/v1/ready  → 200 {"status":"ready","checks":{"database":{"ok":true}}}
```

(`GET /health` without prefix is 404 `content_not_found` — probes live under `/api/v1`.)

### Guest A / Guest B

```
POST /api/v1/auth/guest {"displayName":"ReviewerA One"}
→ user.id usr_qxwnblqvtz4udfozkc7sz4iflp  kind=guest  units=1000

POST /api/v1/auth/guest {"displayName":"ReviewerA Two"}
→ user.id usr_sdd3mnes5aswclhpcnp3vbhnza
```

### PROD-041 Learn / quiz / progress (explicit guest)

```
POST /api/v1/content/quizzes/quiz-hand-flow/attempt
{"questionId":"hand-flow-q1","answer":{"kind":"choice","index":0}}
→ 200 {"correct":true,"recorded":true, "explanation":"Each player is dealt two private cards…"}

POST …/quiz-hand-flow/attempt
{"questionId":"hand-flow-q2","answer":{"kind":"choice","index":0}}
→ 200 {"correct":false,"recorded":true}

POST …/quiz-pot-odds/attempt
{"questionId":"pot-odds-q2","answer":{"kind":"number","value":33.3}}
→ 200 {"correct":true,"recorded":true,
       "expected":{"value":33.33333333333333,"unit":"percent","tolerance":1.5}}

POST /api/v1/content/lessons/hand-flow/read {"completed":true}
→ 200 {"lessonId":"hand-flow","completedAt":"2026-08-19T07:19:30.477Z",…}

GET /api/v1/me/progress   (A)
→ {"lessonsCompleted":["hand-flow"],"quizQuestionsAnswered":3,
   "scenariosAttempted":[],"handsPlayed":0,"topicsTouched":["rules-and-flow"]}

GET /api/v1/me/progress   (B)
→ {"lessonsCompleted":[],"quizQuestionsAnswered":0,…}

GET /api/v1/content/lessons  (A) → completed flags include hand-flow
GET /api/v1/content/lessons  (B) → none completed
```

Anonymous (no guest):

```
POST …/quiz-hand-flow/attempt  (same right answer)
→ 200 {"correct":true,"recorded":false}

GET /me/progress
→ 401 {"error":{"code":"not_authenticated",
      "message":"You need to be signed in — even as a guest — to do that."}}
```

SQL (prl_api):

```
quiz_attempts for A: 3 rows (hand-flow-q1 true, hand-flow-q2 false, pot-odds-q2 true)
quiz_attempts for B: 0
lesson_progress for A: hand-flow completed_at 07:19:30.477Z
```

### Scenario Lab (PROD-008 / 037 / 039 / 043)

```
GET /api/v1/content/scenarios/eq-flush-draw-turn-small-bet
→ 200 analysis.candidates: fold, call, raise×3
   outs {clean:7,dirty:2,total:9}
   equity {heroEquity:0.26796, method:"exact-enumeration", trials:2728, CI:null}
   potOdds {pot:145,toCall:25,breakEvenEquity:0.147…}
   suggestion {action:"raise", sizeRange:{min:67,max:67}, confidence:"reasonable", whatWouldChangeIt:[…]}
   assumptions: 8 strings, always present

POST …/eq-flush-draw-turn-small-bet/attempt {"action":"call"}
→ 200 consistentWithAnalysis:true  (no "recorded" key)

POST … {"action":"fold"}
→ 200 consistentWithAnalysis:false
   "fold is not consistent… about 20.6 chips behind"

POST … {"action":"check"}
→ 200 consistentWithAnalysis:false
   "check is not one of the actions available in this spot…
    It evaluated: fold, call, raise."

POST … {"action":"raise","to":26000}
→ 400 {"fields":{"to":"is more than you can reach: 0 is already out and 500 is behind, so 500 is your whole stack"}}

POST …/does-not-exist/attempt {"action":"call"}
→ 404 content_not_found

POST …/eq-flush-draw-turn-small-bet/attempt {"action":"call"}   (anonymous)
→ 200, same keys as signed-in, no recorded field, no DB row
```

Free-check spot `fl-big-blind-option-limped-pot`:

```
analysis.candidates: check, fold, raise×3

POST {"action":"fold"}
→ 200 consistentWithAnalysis:false
  "you can check here for free. Checking keeps every card still to come and costs nothing,
   so it is never behind folding however thin the hand is."

POST {"action":"check"}
→ 200 consistentWithAnalysis:true
```

Progress after scenarios (A):

```
scenariosAttempted: ["eq-flush-draw-turn-small-bet","fl-big-blind-option-limped-pot"]
topicsTouched includes positions-and-blinds, pot-odds-and-ev, rules-and-flow
```

### Coach legality (PROD-020 / 039 / 017–023)

```
POST /api/v1/math/coach
{heroCards:"AhKh", board:"Qh 7h 2c", opponents:["JJ+"],
 pot:100, toCall:50, heroStack:500, opponentStacks:[500], bigBlind:10, street:"flop"}
→ candidates: fold EV0; call to 50 EV+14.88
   "EV(call) = equity x (pot + toCall) - toCall = 0.4325 x (100 + 50) - 50 = 14.88"
   raise to 100 / 162 / 500 with full EV(raise)= f×pot+(1-f)×[…] arithmetic
   suggestion raise sizeRange 100–162, confidence moderate, whatWouldChangeIt includes 35% fold assumption
   outs clean 7 / dirty 8; equity exact 0.4325; BE 0.333, surplus +0.099, “You clear that”
   uncertainty method exact-enumeration, CI null
   forbidden-word scan: []

Same spot toCall:0 → check, fold, bet×3 (no call). Suggestion bet 25–66.

opponentStacks:[0], toCall:200, board turn
→ fold, call ONLY. Suggestion fold. No raise.

Degenerate pot:0 toCall:0 stacks:0
→ check + fold only (no bet: nobody behind to answer). oddsRatio null.
```

```
POST /api/v1/math/equity {heroCards:"AsAh", opponents:["KsKh"]}
→ heroEquity 0.826366… method exact-enumeration trials 1,712,304
  (suited-config high end of the published AA-vs-KK 81.26–82.64 band; not the 36-config mean)
```

### Rooms + join (PROD-010 / 011)

```
POST /api/v1/rooms
{name:"Invite Table A", maxSeats:6, sb:5, bb:10, startingStack:1000,
 bots:[{profile:"tight-aggressive",count:1},{profile:"calling-station",count:1}]}
→ 201 visibility:"invite_only"
   members: ReviewerA One; Patient Technician (bot, seat 1);
            Calling Station (bot, seat 2)
   inviteCode: 3YFK-UG4R-GAUU-JK8Q

POST /api/v1/rooms/join {"inviteCode":"3YFK-UG4R-GAUU-JK8Q"}  (Guest B)
→ 200 same room, memberCount 4

POST /api/v1/rooms/join {"inviteCode":"NOTAREALCODE99"}
→ 404 invite_code_invalid
```

Live schema:

```
CHECK ((visibility = 'invite_only'::text))
distinct visibility: invite_only
```

### Play a hand + Coach + review (PROD-007 / 012 / 042 / 044 / 045)

WS `ws://127.0.0.1:4101/api/v1/ws` with session cookie + Origin 4100.

```
hello → welcome
sit seat 0 → ack
startHand → event handStarted
            commitmentRoot d31d4a84e5d9ff3d8e60dfe31fe5c91bbac76f9d97dbefc88966086cc6cc0f46
requestCoach → type:coach
  street preflop, method monte-carlo, ci ±2.05 points (95%),
  suggestion raise 20–25 confidence low, assumptionsCount 9
action fold → handComplete
result endedByFold true, netBySeat {0:-5, 1:5}, pots 15 to seat 1
handId hand_qxbnc33lkj2o5ssqbgrryew75x
```

```
GET /api/v1/hands?limit=6&sort=recent → ids [hand_qxbnc33lkj2o5ssqbgrryew75x]
GET /api/v1/hands/hand_qxbnc33lkj2o5ssqbgrryew75x
→ commitmentRoot matches
   verification {ok:true, verifiedPositions:0,
     reason:"nothing became public in this hand — no board was dealt and nobody showed
             — so there is nothing to prove, and an empty reveal is the correct result"}
   decisions[0] {fold, hasAnalysis:true, candidates fold/call/raise}

GET same id as Guest B → 404 hand_not_found
```

`prl.hands`: `has_root true`, `completed true`.

### Units reset (PROD-030)

```
POST /api/v1/me/units/reset → 200 {"units":2000}
```

(Guest A still occupied two rooms × 1000 starting stack; units are derived, not a wallet.)

### Web HTML (selected)

- `/` 200 — “Not a gambling product”, units explanation, no streaks.
- `/learn` 200 — 17-lesson curriculum, **not** personalised; points to `/record`.
- `/learn/hand-flow` 200 — full lesson prose, outline, quiz attached; live-calc chrome present.
- `/learn/tournament-chips-and-icm` 200 — ICM taught as model + SPR calculators, no ICM output.
- `/learn/glossary` 200 — ICM term present.
- `/lab` 200 — 36 live scenarios, attempted flags for anonymous = not attempted.
- `/lab/eq-flush-draw-turn-small-bet` 200 — assumptions first, no assumptions toggle.
- `/play` 200 — open bot table, “Start a private table to invite somebody”, join-by-code form, “assumptions… never hidden”.
- `/record` 200 without cookie — “There is no session to read a record with” (does not show zeroes).
- `/review` 200 without cookie — labelled **Fixture data** from `src/fixtures/review.ts`.

---

## Findings list

### P0

None proven this session (no false taught probability on Coach/Lab/quiz paths exercised; no hidden-card leak attempted beyond redacted views; quiz persistence flag is honest).

### P1

1. **PROD-016 — ICM never computed for the learner.** Maths library unused by lessons, quizzes, Scenario Lab, and Coach. The one tournament scenario that needs prize equity says the app will not compute it.
2. **PROD-028 / PROD-038 — `/learn` does not show the signed-in/guest user’s own progress.** Completion persists and the lessons list API can tick it; the curriculum index is cacheable-anonymous by policy and therefore fails the requirement as written.

### P2

3. **PROD-037 — Scenario attempts are not persistence-honest.** 200 + identical JSON for anonymous vs signed-in; UI “the same one it recorded.” Quizzes already have `recorded`.
4. **PROD-041 / PROD-048 — Default Learn/Lab path does not mint a guest session.** Persistence requires `/play` (or a manual guest POST). Guest-first copy overstates what Learn alone will remember.
5. **PROD-025 — Web fixtures embed computed CoachReports.** Labelled on the fixture path; still hard-coded numbers in `apps/web`.
6. **PROD-040 — `formatPercent` still renders values outside 0..1 as real percents** on lesson/legend surfaces. CoachPanel is independently guarded.

### P3

7. Degenerate Coach (`pot=0`) SPR explanation uses `0 / 1 = 0` rather than refusing a zero pot.
8. Stale comments in `apps/web/src/app/lab/page.tsx` and `fixtures/scenarios.ts` still say `GET /api/scenarios` “does not exist yet”; the live route is `/api/v1/content/scenarios` and was serving 36 spots.
9. `/review` fixture fallback is honest but easy to mistake for a populated history if the “Fixture data” callout is skipped.

---

## What was not done

- Did not run `pnpm test` / content CLAIMS binary this session (read the test, confirmed runtime relationships).
- Did not play a multi-street hand to non-vacuous Merkle reveals (fold-preflop verification is the correct empty proof).
- Did not drive two humans through a full hand on the invite table (join was proven; the completed hand was heads-up vs a bot).
- Did not take the database down to see scenario-attempt behaviour on 500s (would have been the cleanest “does 200 lie about persistence?” probe; anonymous 200 already shows the shape).
- Did not install or reset anything; did not read prior audit markdown as evidence.

---

## Independence note

Implementation comments in this repo often describe bugs as already fixed. Each of those claims was re-checked against a running server and, where relevant, against Postgres. Several “fixed” items (quiz `recorded`, payable sizing, legal-action filter, `/learn` honesty copy, Coach probability guard) are in fact present. Two “fixed” shapes are incomplete: scenario persistence honesty (quiz-only) and `/learn` personalisation (explicitly declined in favour of `/record`).
