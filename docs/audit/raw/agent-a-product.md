# Reviewer A — Product Requirements Audit

**Auditor:** Reviewer A (Product Requirements)
**Date:** 2026-08-18
**Repo:** `/Users/terence/Projects/exploration-sites/poker-risk-lab`
**Environment used:** Node v24.18.0, API started by me on `127.0.0.1:3401`
(`PORT=3401 node apps/api/src/server.ts`), web started by me on `127.0.0.1:3400`
(`next start --port 3400`, `PRL_API_ORIGIN=http://127.0.0.1:3401`), shared Postgres 16
container `poker-risk-lab-postgres-1`.

**Environment caveat, stated up front:** another auditor already held a `next dev` server for
`apps/web`, and Next refuses a second dev server in the same directory. I therefore ran the
**pre-existing production build** (`apps/web/.next`, BUILD_ID `1mMjnr7-uyPOQlNUccuDr`) with
`next start`. Server renders were pointed at my API on 3401 via `PRL_API_ORIGIN`; the
browser-side `/api/*` rewrite is baked into `routes-manifest.json` as `http://localhost:3001`
and could not be retargeted. Every finding below that depends on the browser-side path is
labelled accordingly.

---

## Summary table

| ID | Requirement | Status |
|---|---|---|
| PROD-001 | Learn: syllabus covers every named topic | PASS |
| PROD-002 | Learn: lesson content is real and complete | PASS |
| PROD-003 | Learn: quizzes score correctly (server) | PASS |
| PROD-004 | Learn: quiz attempts are recorded | **FAIL** |
| PROD-005 | Learn: glossary is real and complete | PASS |
| PROD-006 | Guided Practice: bots with recognisable styles | PASS |
| PROD-007 | Guided Practice: a hand can be completed | PASS |
| PROD-008 | Scenario Lab: authored situations, decide-then-reason | PASS |
| PROD-009 | Scenario Lab: custom scenarios | **FAIL** |
| PROD-010 | Play-Money Tables: create a private invite-only table | PASS |
| PROD-011 | Play-Money Tables: join a table by invite code | **FAIL** |
| PROD-012 | Play-Money Tables: play a hand at one | PASS |
| PROD-013 | Hand Review: replay decision by decision | PASS |
| PROD-014 | Hand Review: deck-commitment verification | PASS |
| PROD-015 | Tournament Learning: ICM/tournament content exists | PARTIAL |
| PROD-016 | Tournament Learning: ICM computed for the learner | **FAIL** |
| PROD-017 | Coach: clean vs dirty outs | PASS |
| PROD-018 | Coach: equity labelled exact vs sampled, 95% CI when sampled | PASS |
| PROD-019 | Coach: pot odds + break-even equity + whether it clears | PASS |
| PROD-020 | Coach: EV per **legal** action with arithmetic shown | **FAIL** |
| PROD-021 | Coach: suggestion = size range + confidence + reason + what would change it | PARTIAL |
| PROD-022 | Coach: assumptions always visible, never behind a toggle | PASS |
| PROD-023 | Coach: no field capable of claiming correct/optimal/best | PASS |
| PROD-024 | Content integrity: no hard-coded computed number in `packages/content` | PASS |
| PROD-025 | Content integrity: no hard-coded computed number in web copy/fixtures | **FAIL** |
| PROD-026 | Content integrity: authored teaching point agrees with computed suggestion | **FAIL** |
| PROD-027 | Progress: quiz/scenario/hand progress persists | PARTIAL |
| PROD-028 | Progress: lesson completion persists | **FAIL** |
| PROD-029 | Guardrails: no money, purchase, cash-out, transfer, prizes, crypto, affiliate | PASS |
| PROD-030 | Guardrails: units free / resettable / valueless | PARTIAL |
| PROD-031 | Guardrails: no casino dark patterns | PASS |
| PROD-032 | Guardrails: no public matchmaking, no chat | PASS |
| PROD-033 | Guardrails: `rooms.visibility` CHECK-constrained in the LIVE schema | PASS |
| PROD-034 | AI Legends: generic-archetype naming by default | PASS |
| PROD-035 | AI Legends: no mental-state verbs / no endorsement claim | PASS |
| PROD-036 | AI Legends: behaviour probabilistic, not scripted | PASS |
| PROD-037 | AI Legends: reads only what a human in the seat could read | PASS |
| PROD-038 | Silent fixture-fallback regression is genuinely fixed | PASS |
| PROD-039 | Release candidate's own test suite is green | **FAIL** |
| PROD-040 | Every registered API route is reachable from the product | **FAIL** |

---

## PROD-001 Learn — the syllabus covers every named topic

- **Requirement (exact):** Lessons exist across the syllabus: rules/flow, position/blinds, outs,
  equity, pot odds, EV, fold equity, bet sizing, SPR, ranges, variance, bankroll, tournament ICM.
- **Status:** PASS
- **Implementation location:** `packages/content/data/lessons/foundations.json`,
  `packages/content/data/lessons/decisions.json` (134 KB combined); served by
  `apps/api/src/routes/content.ts:887`.
- **Runtime evidence:**

```
$ curl -s http://127.0.0.1:3401/api/v1/content/lessons
lesson count: 17
 - hand-flow | rules-and-flow | intro | quiz: quiz-hand-flow
 - betting-actions | rules-and-flow | intro
 - position-basics | positions-and-blinds | intro
 - reading-the-board | hand-reading-and-outs | intro
 - counting-outs | hand-reading-and-outs | core
 - pot-odds | pot-odds-and-ev | core
 - expected-value | pot-odds-and-ev | core
 - fold-equity | fold-equity-and-bluffing | core
 - bet-sizing | bet-sizing-and-spr | core
 - stack-to-pot-ratio | bet-sizing-and-spr | core
 - variance | variance-and-bankroll | core
 - all-ins-and-side-pots | rules-and-flow | core
 - blinds-and-the-option | positions-and-blinds | core
 - rule-of-2-and-4 | probability-and-equity | core
 - ranges-and-combos | ranges | advanced
 - sample-size-and-risk-of-ruin | variance-and-bankroll | advanced
 - tournament-chips-and-icm | tournaments | advanced
```

  Every one of the 13 named subjects is present. Prerequisite chains are populated and acyclic
  (e.g. `pot-odds` requires `betting-actions` + `counting-outs`).
- **Test covering it:** `packages/content/test/scenarios.test.ts`, `apps/api/test/content-routes.test.ts`
- **Test result:** `packages/content` 13/13 pass; `apps/api` content-route tests within 532/534 pass
- **Reviewer notes:** Coverage is genuine, not a stub list.
- **Missing work:** none

## PROD-002 Learn — lesson content is real and complete

- **Requirement (exact):** Lesson bodies are real prose, not placeholders, and render.
- **Status:** PASS
- **Implementation location:** `apps/api/src/routes/content.ts:897`; rendered by
  `apps/web/src/app/learn/[lessonId]/page.tsx` + `apps/web/src/components/LessonBlockRenderer.tsx`
- **Runtime evidence:** three lessons fetched whole:

```
=== hand-flow ===        status=200 bytes=13992   blocks: 16
=== pot-odds ===         status=200 bytes=14378   blocks: 17
=== tournament-chips-and-icm === status=200 bytes=17144  blocks: 19
```

  Block kinds seen: `prose`, `heading`, `list`, `callout` (`insight` / `misconception` /
  `warning`), `formula`, `liveCalculation`. Across all lessons: 95 prose, 72 heading, 46 callout,
  35 liveCalculation, 25 list, 14 formula.

  Rendered page (`GET http://127.0.0.1:3400/learn/pot-odds`, API up) contains the figures
  **computed at render time**:

```
33.3 %  <- ...before your call 120 units Cost to call 60 units Break-even equity 33.3 %...
25.0 %  <- ...before your call 90 units Cost to call 30 units Break-even equity 25.0 %...
40.0 %  <- ...before your call 180 units Cost to call 120 units Break-even equity 40.0 %...
assumption markers: 6 | "not live" notice: false
```
- **Test covering it:** `apps/api/test/content-routes.test.ts`
- **Test result:** pass (inside the 532 passing API tests)
- **Reviewer notes:** Quality is high and the prose is original-sounding, specific and long-form.
- **Missing work:** none

## PROD-003 Learn — quizzes score correctly (server)

- **Requirement (exact):** Quizzes score correctly; numeric answers are graded against a
  runtime-computed value, not a stored one.
- **Status:** PASS
- **Implementation location:** `apps/api/src/routes/content.ts:956-990` (route),
  `expectedValueFor` at `apps/api/src/routes/content.ts:641-668`
- **Runtime evidence:**

```
$ POST /api/v1/content/quizzes/quiz-pot-odds/attempt {"questionId":"pot-odds-q2","answer":{"kind":"number","value":33.3}}
{"correct":true, ... "expected":{"value":33.33333333333333,"unit":"percent","tolerance":1.5}}

$ ... same question, value 50
{"correct":false, ... "expected":{"value":33.33333333333333,...}}

$ POST ... {"questionId":"pot-odds-q1","answer":{"kind":"choice","index":1}}   -> {"correct":true, ...}
$ POST ... {"questionId":"pot-odds-q1","answer":{"kind":"choice","index":0}}   -> {"correct":false, ...}
$ POST ... {"questionId":"pot-odds-q4","answer":{"kind":"number","value":3}}
{"correct":true, ... "expected":{"value":3,"unit":"ratio","tolerance":0.2}}
```

  The expected value comes back as `33.33333333333333`, i.e. computed, not a rounded stored
  constant. The explanation string is assembled at request time and contains the arithmetic
  (`50 / (100 + 50) = 33.3%`).
- **Test covering it:** `apps/api/test/content-routes.test.ts`
- **Test result:** pass
- **Reviewer notes:** Grading and unit/field validation are genuinely defensive — the handler
  throws `internal_error` if a question's declared unit disagrees with the computed field's unit.
- **Missing work:** none

## PROD-004 Learn — quiz attempts are recorded

- **Requirement (exact):** Progress records: quiz attempts are recorded for the learner.
- **Status:** **FAIL**
- **Implementation location:** endpoint `apps/api/src/routes/content.ts:956`; path constant
  `packages/contracts/src/api-paths.ts` (`quizAttempt`); consumer — **NONE FOUND**.
- **Runtime evidence:** the shipped quiz UI never calls the endpoint. `QuizRunner` grades entirely
  in the browser:

```
$ grep -n "apiSend|API_PATHS|quizAttempt|fetch" apps/web/src/components/QuizRunner.tsx
(no matches)

$ grep -rn "API_PATHS\.[a-zA-Z]*(" apps/web/src | sed 's/.*API_PATHS\.\([a-zA-Z]*\)(.*/\1/' | sort | uniq -c
   3 ws
   3 session
   2 scenarios
   2 rooms
   1 scenarioAttempt
   1 scenario
   1 lessons
   1 lesson
   1 legendProfileStats
   1 legendProfiles
   1 legendProfile
   1 legendCompare
   1 hands
   1 hand
   1 guest
   1 glossary
```

  `quizAttempt` is the **only** entry in `API_PATHS` with zero call sites in `apps/web`.
  `apps/web/src/components/QuizRunner.tsx:230` derives the expected answer locally via
  `expectedFromResult(outcome.result, question)`.
- **Test covering it:** NONE. `apps/api/test/web-api-paths.test.ts:180` only asserts the
  *reverse* direction ("every path the web client can emit is a registered route"), so an
  unused path passes.
- **Test result:** not applicable — no test asserts the client submits a quiz answer.
- **Reviewer notes:** The consequence is that `prl.quiz_attempts` receives no rows from a real
  user of the web app, and `ProgressResponse.quizQuestionsAnswered` is permanently 0 for them.
  I proved the endpoint works only by driving it with curl. The product does not drive it.
- **Missing work:** wire `QuizRunner` to `POST API_PATHS.quizAttempt(...)`, and add a test that
  asserts each `API_PATHS` entry has at least one call site in `apps/web/src`.

## PROD-005 Learn — glossary

- **Requirement (exact):** A real glossary is available.
- **Status:** PASS
- **Implementation location:** `packages/content/data/glossary.json` (40 KB);
  `apps/api/src/routes/content.ts:940`; `apps/web/src/components/GlossaryBrowser.tsx`
- **Runtime evidence:**

```
$ curl -s http://127.0.0.1:3401/api/v1/content/glossary
entries: 90
{ "id":"all-in", "term":"All-in",
  "definition":"Committing your entire remaining stack. It is not a separate action but a bet,
   raise or call that happens to use your last units, and it caps what you can win from each
   opponent at what you put in.",
  "topics":["rules-and-flow","tournaments"],
  "seeAlso":["table-stakes","side-pot","main-pot","push-fold"] }

$ curl -s -o page_learn_glossary.html http://127.0.0.1:3400/learn/glossary
/learn/glossary -> 200  163728b   (no fixture notice)
```

  90 entries with cross-references. Includes `icm`, `risk-of-ruin`, `clean-out`, `dirty-out`,
  `minimum-defence-frequency`, `m-ratio`.
- **Test covering it:** `apps/api/test/content-routes.test.ts`
- **Test result:** pass
- **Missing work:** none

## PROD-006 Guided Practice — bots with recognisable styles

- **Requirement (exact):** Guided play against bots with recognisable styles.
- **Status:** PASS
- **Implementation location:** `packages/poker-ai/src/profiles.ts`, `packages/poker-ai/src/policy.ts`,
  `apps/api/src/rooms/bots.ts`
- **Runtime evidence:** created a private room requesting two distinct profiles; both were seated
  with distinct archetype display names:

```
$ POST /api/v1/rooms  {"bots":[{"profile":"calling-station","count":1},{"profile":"nit","count":1}]}
201 Created
 members:
   Auditor A               seat null  human
   "Calling Station"       seat 1  isBot true  botProfile "calling-station"
   "Disciplined Specialist" seat 2  isBot true  botProfile "disciplined-specialist"
```

  Over four hands the two bots produced visibly different lines (one led out on turn and river,
  one folded a river bet) and the schema restricts the stored profile:
  `room_members_bot_profile_allowed CHECK (bot_profile = ANY (ARRAY['nit','tight-aggressive',
  'loose-aggressive','calling-station','maniac','unknown']))`.
- **Test covering it:** `packages/poker-ai/test/simulation/profile-differentiation.test.ts`,
  `packages/poker-ai/test/policy.test.ts`, `apps/api/test/bots.test.ts`
- **Test result:** `packages/poker-ai` 148/148 pass; simulation suite result recorded under PROD-036
- **Missing work:** none

## PROD-007 Guided Practice — a hand can be completed

- **Requirement (exact):** A hand can be played to completion against the bots.
- **Status:** PASS
- **Implementation location:** `apps/api/src/rooms/table.ts`, `apps/api/src/ws/router.ts`,
  `apps/web/src/app/play/LiveTable.tsx`
- **Runtime evidence:** I wrote a WebSocket client (`ws` from `apps/api/node_modules`) that
  performed `hello` → `sit` → `startHand` → `action`… against my API on 3401, forwarding the guest
  session cookie and `Origin: http://127.0.0.1:3400`:

```
  act#1 h1 turn    pot 25  toCall 0  legal fold,check,bet  -> check
  act#2 h1 river   pot 25  toCall 0  legal fold,check,bet  -> check
HAND 1 COMPLETE hand_c7zg32msqfypdf76p675ljnf5k  seats: 0:1003 1:947 2:1050
  act#3 h2 preflop pot 15 toCall 5   -> call
  act#4..7 (flop/turn/river)         -> check,check,check,call
HAND 2 COMPLETE hand_xvdsgqfgz6uaj3xqhlyy7slarz  seats: 0:1026 1:924 2:1050
  act#8..11 h3 preflop/flop/turn/river -> call,check,call,call
HAND 3 COMPLETE hand_iukgpemluxqeptxjcrqv4fcyf4  seats: 0:1135 1:896 2:969
HAND 4 COMPLETE hand_pzx2zv77wty7qfhke7tck6y7si  seats: 0:1140 1:896 2:964
=== hands completed: 4  hero actions: 11  coach reports: 2
events: handStarted,forcedBets,action,action,action,street,...,showdown,handComplete, (x4)
```

  Chip conservation holds: 1140 + 896 + 964 = 3000 = 3 × 1000 starting stack.
- **Test covering it:** `apps/api/test/ws-socket.test.ts`, `apps/api/test/rooms.test.ts`,
  `apps/api/test/table-concurrency.test.ts`
- **Test result:** pass (within 532/534)
- **Reviewer notes:** Verified over the real socket, not over `app.inject`. The browser client
  (`LiveTable.tsx`) is separately covered by 22 passing `apps/web` unit tests including the
  frame-narrowing and reconnect-backoff tests; I could not drive it in a browser here (see the
  environment caveat).
- **Missing work:** none for the server path.

## PROD-008 Scenario Lab — authored situations, decide-then-reason

- **Requirement (exact):** Hand situations, learner decides, then sees reasoning.
- **Status:** PASS
- **Implementation location:** `packages/content/data/scenarios/*.json` (131 KB, 36 scenarios);
  `apps/api/src/routes/content.ts:931` and `:994`; `apps/web/src/components/ScenarioStage.tsx`
- **Runtime evidence:**

```
$ curl -s http://127.0.0.1:3401/api/v1/content/scenarios
scenario count: 36
  pot-odds-and-ev -> 6   probability-and-equity -> 6   rules-and-flow -> 3
  positions-and-blinds -> 4   hand-reading-and-outs -> 5   bet-sizing-and-spr -> 3
  fold-equity-and-bluffing -> 2   ranges -> 2   variance-and-bankroll -> 2
  tournaments -> 2   risk-psychology -> 1
```

  The rendered page asks for a decision **before** revealing analysis (server HTML for
  `/lab/flop-spr-commitment`): *"Choose the action you would take. Nothing is scored — the point
  of committing first is that reading an analysis before you have decided teaches you very little
  about your own reasoning."* Committing an action returns the reasoning:

```
$ POST /api/v1/content/scenarios/rk-the-fold-that-feels-wrong/attempt {"action":"fold"}
{ consistentWithAnalysis, reasoning, analysis, commonMistakes }
```
- **Test covering it:** `packages/content/test/scenarios.test.ts`
- **Test result:** 13/13 pass
- **Reviewer notes:** The mode works. Its *content correctness* is a separate, failing requirement
  — see PROD-020 and PROD-026.
- **Missing work:** none for the flow itself.

## PROD-009 Scenario Lab — custom scenarios

- **Requirement (exact):** Custom scenarios (the learner can construct or vary a situation).
- **Status:** **FAIL**
- **Implementation location:** NONE FOUND
- **Runtime evidence:**

```
$ grep -rni "custom scenario|customScenario|createScenario|build your own|Build a scenario" \
    apps/web/src apps/api/src packages/contracts/src
(no matches)
```

  There is no `POST /content/scenarios`, no scenario editor, and no control on the scenario page
  that changes an analysis input. `ScenarioStage` has a bet-size slider, but that selects the
  learner's *action*, not an input to the maths — the opponent range and the fold-equity
  assumption are fixed by the content file. The nav copy claims the Lab is where you
  "change one input, watch the maths move" (`apps/web/src/lib/nav.ts:36`); what is actually
  shipped is *pairs of authored scenarios* that differ in one input.

  The two ad-hoc calculation endpoints that could have backed a custom scenario exist on the API
  but are not in `API_PATHS` and are called by nothing:

```
$ curl -s -X POST .../api/v1/math/equity -d '{"heroCards":"AhKh","board":"7c8d2s","opponents":["QQ"],"samples":20000}'
{"equity":{"heroEquity":0.2393...,"method":"exact-enumeration","trials":5940,...}}

$ grep -rn "math/equity|math/coach" apps/web/src
(no matches)
```
- **Test covering it:** NONE
- **Test result:** not executed
- **Reviewer notes:** The capability exists on the server and is unreachable from the product.
- **Missing work:** either build the custom-scenario surface on top of `POST /math/coach`, or
  drop the claim from the navigation copy.

## PROD-010 Play-Money Tables — create a private invite-only table

- **Requirement (exact):** A learner can create a private, invite-only table.
- **Status:** PASS
- **Implementation location:** `apps/api/src/routes/rooms.ts:255`;
  `apps/web/src/lib/table-rooms.ts:122` (`createBotRoom`)
- **Runtime evidence:**

```
$ POST /api/v1/rooms {"name":"Audit Table A","maxSeats":3,"smallBlind":5,"bigBlind":10,
                      "startingStack":1000,"actionTimeoutSeconds":30,"bots":[...]}
status=201
{"room":{"id":"room_txksaeq6efsmo7ovoqpfpgdxrs", ..., "visibility":"invite_only", ...},
 "inviteCode":"GTDE-8VY9-PQCK-XNNG"}
```
- **Test covering it:** `apps/api/test/rooms.test.ts`
- **Test result:** pass
- **Missing work:** none

## PROD-011 Play-Money Tables — join a table by invite code

- **Requirement (exact):** Private invite-only tables — a second person can join.
- **Status:** **FAIL**
- **Implementation location:** endpoint `apps/api/src/routes/rooms.ts:280`
  (`POST /rooms/join`); client — **NONE FOUND**
- **Runtime evidence:**

```
$ grep -rn "inviteCode|invite code|Invite" apps/web/src --include=*.ts --include=*.tsx
apps/web/src/lib/table-rooms.ts:118: * The invite code comes back exactly once and is not stored
                                       anywhere by this client.
```

  That single hit is a comment. There is no input field, no display of the code, and no call to
  `/rooms/join` — `rooms` is the only room path in `API_PATHS` at all, and it is `GET` (list) and
  `POST` (create). `POST /rooms/join`, `GET /rooms/:roomId`, `POST /rooms/:roomId/leave` are all
  registered on the API and absent from `API_PATHS`, and `apps/web` is forbidden from constructing
  a path outside that table (asserted by `apps/api/test/web-api-paths.test.ts:313`).

  `/play` (`apps/web/src/app/play/page.tsx`) creates a room with five bots and sits the reader down;
  `chooseRoom` (`apps/web/src/lib/table-rooms.ts:133`) reuses only rooms the reader **owns**.
- **Test covering it:** `apps/api/test/rooms.test.ts` covers the endpoint; nothing covers a second
  independent human session joining through the product.
- **Test result:** endpoint tests pass; the product journey was never testable.
- **Reviewer notes:** Two independent sessions joining and completing a hand — the pass bar named
  in the common brief for "private multiplayer" — cannot be reached through the shipped UI at all,
  because the invite code is generated, never shown, and immediately discarded by the client that
  received it. Multiplayer is server-complete and product-absent.
- **Missing work:** show the invite code after creation, add a join-by-code entry point, and add
  `join`/`room`/`leave` to `API_PATHS`.

## PROD-012 Play-Money Tables — play a hand at one

- **Requirement (exact):** A hand can be played at a created table.
- **Status:** PASS
- **Implementation location:** as PROD-007
- **Runtime evidence:** see PROD-007 — 4 hands completed at `room_txksaeq6efsmo7ovoqpfpgdxrs`,
  persisted to `prl.hands` and readable back through `GET /api/v1/hands` (5 rows).
- **Test result:** pass
- **Missing work:** none

## PROD-013 Hand Review — replay decision by decision

- **Requirement (exact):** Replay a completed hand decision by decision.
- **Status:** PASS
- **Implementation location:** `apps/api/src/review/build-review.ts`;
  `apps/api/src/routes/hands.ts`; `apps/web/src/components/HandReplay.tsx`,
  `apps/web/src/components/DecisionTimeline.tsx`
- **Runtime evidence:**

```
$ curl -s -b jar.txt http://127.0.0.1:3401/api/v1/hands/hand_iukgpemluxqeptxjcrqv4fcyf4
status=200 bytes=35506
decisions: 14
  seq 1  preflop seat 0 call  paid 10 potBefore 15  analysis: yes suggest=fold/low
  seq 2  preflop seat 1 call  paid 5  potBefore 25  analysis: null
  seq 3  preflop seat 2 check paid 0  potBefore 30  analysis: null
  ...
  seq 9  turn    seat 0 call  paid 18 potBefore 48  analysis: yes suggest=raise/low
  seq 13 river   seat 0 call  paid 53 potBefore 137 analysis: yes suggest=raise/reasonable
  seq 14 river   seat 1 fold  paid 0  potBefore 190 analysis: null

$ curl -s -b jar.txt -o rev1.html http://127.0.0.1:3400/review/hand_iukgpemluxqeptxjcrqv4fcyf4
-> 200  129972b   (markers found: commitmentRoot, commitmentContext, Merkle, verifiedPositions)
$ curl -s -b jar.txt -o rev.html http://127.0.0.1:3400/review
-> 200, lists exactly my five real hand ids, no fixture notice
```

  Analysis is present only for the viewer's own seat (seat 0) and `null` for opponents — correct,
  because analysing an opponent's decision would require their hole cards.
- **Test covering it:** `apps/api/test/hands.test.ts`, `apps/api/test/hand-sort.test.ts`
- **Test result:** pass
- **Missing work:** none for the replay itself. The per-decision analysis inherits the PROD-020
  legality defect (`build-review.ts:744` does not pass `legalActions` either).

## PROD-014 Hand Review — deck-commitment verification

- **Requirement (exact):** Deck-commitment verification is available and is verified by the client,
  not merely asserted by the server.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/commitment.ts` (`verifyDeckReveal`);
  `apps/web/src/components/CommitmentVerifier.tsx:193-210`
- **Runtime evidence:**

```
$ curl -s -b jar.txt .../api/v1/hands/hand_iukgpemluxqeptxjcrqv4fcyf4 | jq .verification
{"ok": true, "verifiedPositions": 9}
```

  The browser component does not trust that. `CommitmentVerifier.tsx:199-208` re-runs the engine's
  own `verifyDeckReveal` in an effect and holds the server's answer separately as
  `serverVerification`, so the two are compared rather than echoed. Nine positions is correct for
  that hand: 5 board cards + 2 × 2 shown hole cards.
- **Test covering it:** `packages/poker-engine/test/commitment.test.ts`,
  `apps/api/test/hands.test.ts`
- **Test result:** `packages/poker-engine` 119/119 pass
- **Missing work:** none

## PROD-015 Tournament Learning — ICM/tournament content exists

- **Requirement (exact):** ICM / tournament content and flow.
- **Status:** PARTIAL
- **Implementation location:** lesson `tournament-chips-and-icm`
  (`packages/content/data/lessons/decisions.json`); scenarios `rk-nine-big-blinds-call-or-fold`,
  `rk-when-survival-outweighs-chip-ev`; glossary entries `icm`, `m-ratio`, `push-fold`
- **Runtime evidence:** the lesson is real and substantial (19 blocks, 17 KB) and opens with the
  guardrail callout *"Nothing of value is awarded here — the tournaments in this lab award no
  money, no prizes …"*. It states the model honestly: *"'ICM says fold' — ICM is a model with
  strong assumptions, not an oracle. It ignores …"*.
- **Test covering it:** `packages/poker-math/test/icm.test.ts`
- **Test result:** `packages/poker-math` 232/232 pass (icm tests included)
- **Reviewer notes:** There is content and there is a maths library. What there is **not** is a
  tournament *flow*: no tournament table, no blind levels, no payout ladder, no bubble. The
  "flow" half of the requirement is unimplemented. Combined with PROD-016 this mode is the
  weakest of the seven.
- **Missing work:** either build a tournament flow or scope the claim to "tournament content".

## PROD-016 Tournament Learning — ICM computed for the learner

- **Requirement (exact):** Every number the learner sees is computed at runtime by
  `@prl/poker-math` — including the ICM numbers in the ICM lesson.
- **Status:** **FAIL**
- **Implementation location:** `packages/poker-math/src/icm.ts:274` (`icmEquity`), `:376`
  (`icmVsChipEv`), `:512` (`pushFoldChipEv`) — exported from
  `packages/poker-math/src/index.ts:113-118` and consumed by **NOTHING**.
- **Runtime evidence:**

```
$ grep -rn "icmEquity|icmVsChipEv|pushFoldChipEv" apps/api/src apps/web/src
(no matches)

$ grep -o '"kind": *"[a-zA-Z0-9]*"' packages/content/data/lessons/*.json | sort | uniq -c
   35 liveCalculation
    7 "potOdds"   7 "equity"   4 "variance"   4 "spr"
    3 "ruleOf24"  3 "riskOfRuin"  3 "outs"  2 "foldEquity"  2 "callEv"
   (zero "icm")
```

  `LiveCalculation` in `packages/contracts/src/content-types.ts:91-131` has no `icm` variant, so
  it is structurally impossible for a lesson to show a computed ICM figure. The ICM lesson's two
  `liveCalculation` blocks are both `spr` (chip-based). Every ICM statement in the lesson is
  therefore prose only.

  Worse, the tournament scenarios are analysed with **pure chip EV**. `rk-when-survival-outweighs-
  chip-ev` — a scenario whose entire teaching point is that survival outweighs chip EV — is given
  a chip-EV suggestion of `raise` at `reasonable` confidence.
- **Test covering it:** `packages/poker-math/test/icm.test.ts` tests the library in isolation.
  Nothing tests that a learner ever sees an ICM number.
- **Test result:** library tests pass; the product path does not exist.
- **Reviewer notes:** This is the "tested library, unwired product" pattern. The maths is real; the
  learner never meets it.
- **Missing work:** add an `icm` `LiveCalculation` kind and wire `icmVsChipEv` into the ICM lesson
  and the two tournament scenarios.

## PROD-017 Coach — clean vs dirty outs

- **Requirement (exact):** At every decision the Coach surfaces clean vs dirty outs.
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/outs.ts`;
  `packages/poker-math/src/coach.ts:414`; rendered by `packages/ui/src/components/CoachPanel.tsx`
- **Runtime evidence:** I enumerated all 36 scenarios through the live API. Every scenario that has
  an outs situation reports a clean/dirty split with the card lists:

```
"outs": { "clean": 7, "dirty": 2, "total": 9,
          "cleanCards": ["5h","Ah","4h","8h","6h","9h","Th"],
          "dirtyCards": ["2h","3h"],
          "explanation": "... Of the 46 cards that can come next, 7 are clean and 2 are dirty,
            which is 9 outs in total. Clean means hero's equity after that card is at least 90%;
            dirty means at least 50% but below 90%." }
```

  Across the 36: splits such as `5c/8d`, `0c/39d`, `38c/3d`, `7c/40d`, `11c/7d` all present.
  The live-table Coach also reported `outs 10c/27d` over the WebSocket.
- **Test covering it:** `packages/poker-math/test/outs.test.ts`, `packages/poker-math/test/coach.test.ts`
- **Test result:** 232/232 pass
- **Missing work:** none

## PROD-018 Coach — equity labelled exact vs sampled, 95% CI when sampled

- **Requirement (exact):** Equity is labelled exact vs sampled, with a 95% confidence interval
  when sampled.
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/coach.ts:395-405`, `:815-850`
- **Runtime evidence:** enumeration of all 36 scenarios:

```
methods: {"exact-enumeration":30,"monte-carlo":6}
sampled with null CI: []          <- every sampled report carries an interval
example (exact):   confidenceHalfWidthPoints: null,
                   uncertainty.confidenceInterval: null,
                   summary: "Computed exactly by enumerating every remaining board (2,728
                             run-outs). There is no sampling error."
example (sampled): confidenceHalfWidthPoints: 0.4355...,
                   uncertainty.confidenceInterval: {"level":0.95,"halfWidthPoints":0.4355...}
```

  Zero sampled reports had a null interval. `uncertainty.limitations` was non-empty in 36/36.
- **Test covering it:** `packages/poker-math/test/equity.test.ts`, `.../coach.test.ts`
- **Test result:** 232/232 pass
- **Missing work:** none

## PROD-019 Coach — pot odds + break-even equity + whether it clears

- **Requirement (exact):** Pot odds, break-even equity, and an explicit statement of whether the
  learner's equity clears it.
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/odds.ts`; `coach.ts` `potOdds` block
- **Runtime evidence:**

```
"potOdds": { "pot":145, "toCall":25, "breakEvenEquity":0.14705882352941177,
  "oddsRatio":5.8, "equitySurplus":0.12090305330343279,
  "explanation":"Hero risks 25 to win the 145 already in the middle, a price of 5.80 to 1.
    Calling breaks even at 25 / (145 + 25) = 14.7% equity: with less than that, calling loses
    units over many repetitions of this spot; with more, it gains them. The 145 is what is in
    the middle before hero's own 25 goes in — counting the call inside the pot understates the
    equity a call needs. You clear that with 26.8% equity, a 12.1 point surplus." }
```

  `equitySurplus` is a first-class field, and the sentence states the verdict in words.
- **Test covering it:** `packages/poker-math/test/odds.test.ts`
- **Test result:** pass
- **Missing work:** none

## PROD-020 Coach — EV per LEGAL action with arithmetic shown

- **Requirement (exact):** EV per **legal** action, with the arithmetic shown.
- **Status:** **FAIL** — the arithmetic is shown; the actions are not all legal.
- **Implementation location:**
  - guard that exists: `packages/poker-math/src/coach.ts:153` (`legalActions?:` — **optional**)
    and `:556` (`input.legalActions === undefined || input.legalActions.includes(action)`)
  - path that supplies it: `apps/api/src/ws/router.ts:653, 684` (live table only)
  - paths that do **not**: `apps/api/src/workers/equity-worker.ts:105-120` (`CoachTask` has **no
    `legalActions` field at all**) and `:208-227` (`runCoach` cannot forward one), used by
    `apps/api/src/routes/content.ts:363` (Scenario Lab) and `apps/api/src/routes/calc.ts:172`
    (`POST /math/coach`); also `apps/api/src/rooms/bots.ts:827-846` (Legends compare) and
    `apps/api/src/review/build-review.ts:744` (Hand Review).
- **Runtime evidence:** I enumerated every shipped scenario and asked which ones leave **no
  opponent with chips behind** — the exact condition under which the engine refuses aggression
  (`packages/poker-engine/src/betting.ts:192-227`: *"Aggression needs somebody who could answer it.
  If every opponent still in the hand is all-in, a bet or raise cannot be called and would simply
  be returned"*):

```
$ node illegal.ts
scenarios where NO opponent has chips behind (bet/raise is ILLEGAL per engine): 3
  - eq-rule-of-four-big-draw-flop | BB:170/committed 170
  - eq-set-on-connected-flop-jam  | BTN:150/committed 150
  - rk-an-all-in-that-is-nearly-even | CO:220/committed 220
```

  Two of those three publish an illegal `raise` as the headline suggestion. The Coach offers it,
  prices it with fabricated fold equity, and recommends it:

```
=== eq-set-on-connected-flop-jam ===
facing: Hero checks and the button moves all in for 150 into a pot of 90.
seats:  HJ stack=320 (HERO) , BTN stack=150      <- BTN is all-in, nothing behind
   cand: fold  cost=0   ev=0.0
   cand: call  to=150 cost=150 ev=126.9
   cand: raise to=320 cost=320 ev=212.9          <- ILLEGAL
suggest: "raise" { min: 320, max: 320 }          confidence: reasonable

=== eq-rule-of-four-big-draw-flop ===
facing: The big blind moves all in for 170 into a pot of 60.
seats:  BB stack=170 , BTN stack=260 (HERO)
   cand: raise to=260 cost=260 ev=123.6          <- ILLEGAL, and beats call (ev=55.1)
suggest: "raise" { min: 260, max: 260 }

```

  Both raise EVs are computed as `EV(raise) = f × pot + (1 − f) × [...]` with `f = 0.35` — 35%
  fold equity credited against an opponent who is already all-in and cannot fold.

  A related and equally damaging case, `rk-nine-big-blinds-call-or-fold` (the tournament
  push/fold scenario):

```
facing: "The button folds and the small blind moves all in for 7,200, which is their whole stack."
seats:  BTN stack=18000, SB stack=7200 (all-in), BB stack=10000 (HERO)
   cand: fold  ev=0.0
   cand: call  to=7200  cost=6400  ev=1235.2
   cand: raise to=10800 cost=10000 ev=3744.4
suggest: "raise" { min: 10800, max: 10800 }   confidence: reasonable
```

  Here the prose says the button folded, but the scenario format has no way to mark a seat as
  folded — `readSituation` still reports the button as a live opponent with 18 000 behind. So the
  Coach prices a re-shove and credits it with 35% fold equity against a player who has already
  folded and a player who is already all-in. That is a content-model gap on top of the missing
  legality guard, and it lands on the one scenario whose whole subject is the push/fold decision.
- **Test covering it:** `packages/poker-math/test/coach-legality.test.ts`
- **Test result:** **passes — and that is the problem.** Its header states the exact bug it exists
  to prevent ("a spot where every live opponent was all-in, the engine offered `fold, call`, the
  Coach published three raises, and its headline suggestion was 'raise to 80-100' at 'reasonable
  confidence'"). But the test reconstructs a `HandState` and hands `legalActions` to
  `buildCoachReport` itself, whereas the production Scenario Lab path (`coachTaskFor` →
  `CoachTask` → `runCoach`) has no field in which to carry it. The test therefore green-lights a
  code path the product does not use.
- **Reviewer notes:** This is my hardest-hitting finding. The legality guard is applied in exactly
  **1 of the 5** Coach surfaces. It is missing from the Scenario Lab (the flagship learning mode),
  Hand Review, Legends compare, and `POST /math/coach`.
- **Missing work:** add `legalActions` to `CoachTask` and forward it from `coachTaskFor`,
  `build-review.ts::analyse` and `bots.ts::coachReportFor`; make `CoachInput.legalActions`
  non-optional so a caller cannot omit it; extend `coach-legality.test.ts` to drive the wire
  type rather than `buildCoachReport` directly.

## PROD-021 Coach — suggestion: size range + confidence + reason + what would change it

- **Requirement (exact):** A suggestion with a size RANGE, a confidence level (allowed to be "low"),
  a reason, and an explicit list of what would change it.
- **Status:** PARTIAL
- **Implementation location:** `packages/poker-math/src/coach.ts:716-812`;
  `packages/contracts/src/api-types.ts:257-276`
- **Runtime evidence:** over all 36 scenarios:

```
confidences: {"reasonable":21,"moderate":11,"low":4}     <- "low" is genuinely reachable
whatWouldChangeIt empty: 0 of 36
sizeRange examples: 133-380, 60-118, 51-95, 43-83, 350-440, 80-155, 22-28   (genuine ranges)
sizeRange degenerate (min==max): 20 of the 29 scenarios that carry one
sizeRange absent: 7 (all fold/check suggestions — correct)
```

  Sample suggestion:

```
"suggestion": { "action":"raise", "sizeRange":{"min":67,"max":67}, "confidence":"reasonable",
  "reason":"raise has the highest expected value against the stated range, by 21.4 chips over
            the next-best action.",
  "whatWouldChangeIt":[
    "This assumes the line wins uncontested 35% of the time. An opponent who folds less often
     makes it worse.",
    "Being raised is not modelled here, so treat the figure as optimistic.",
    "2 of your 9 outs are dirty — they improve you without making you safe, so counting all of
     them would overstate your chances."] }
```
- **Test covering it:** `packages/poker-math/test/coach.test.ts`
- **Test result:** 232/232 pass
- **Reviewer notes:** All four required parts are present and non-empty. Marked PARTIAL rather
  than PASS for two reasons: (a) in 20 of 29 cases the "range" collapses to a single number, so
  the promise the type makes — *"a range rather than a single number because sizing is not that
  precise"* — is not delivered most of the time; (b) the suggestion is drawn from a candidate set
  that can contain illegal actions (PROD-020), so 24/36 published suggestions name an action the
  scenario itself does not offer (see PROD-026).
- **Missing work:** fix PROD-020 first; then reconsider the ±1 big blind band that collapses the
  range.

## PROD-022 Coach — assumptions always visible, never behind a toggle

- **Requirement (exact):** Assumptions are ALWAYS visible and are never hidden behind a toggle.
- **Status:** PASS
- **Implementation location:** `packages/ui/src/components/AssumptionList.tsx:6`;
  `packages/ui/src/components/CoachPanel.tsx:674`
- **Runtime evidence:**

```
$ grep -n "details|summary|toggle" packages/ui/src/components/AssumptionList.tsx
6: * There is no `<details>`, no "show assumptions" toggle, and no truncation. A figure ...

$ grep -n "Disclose summary=" packages/ui/src/components/CoachPanel.tsx
587:  <Disclose summary={`What each action is worth (${...} line)`}>
592:  <Disclose summary={`Outs, card by card (${...} card)`}>
618:  <Disclose summary="How these figures are derived">
664:  <Disclose summary={`Worth noticing here (${...} note)`}>
674:  {/* Neither of these can be collapsed. See the boundary at the top of this file. */}
```

  `AssumptionList` and the uncertainty note are the two things rendered after line 674 and are
  outside every `<details>`. The API guarantees the list is never empty
  (`apps/api/src/routes/content.ts:365-369` refuses to serve a report with zero assumptions), and
  I measured `assumptions.length` between 6 and 10 across all 36 scenarios, and 8–10 on the live
  table over the socket.

  Rendered lesson page carried 6 assumption blocks inline with no disclosure wrapper.
- **Test covering it:** `packages/ui/test/coach-panel-render.test.ts` (renders the panel to static
  markup and asserts on the string a reader sees)
- **Test result:** `packages/ui` 186/186 pass
- **Reviewer notes:** The EV term table *is* collapsible, which the guardrail explicitly permits
  (§6.2 in `LiveCalculation`'s own header); the assumptions and the uncertainty note are not.
- **Missing work:** none

## PROD-023 Coach — no field capable of claiming correct/optimal/best

- **Requirement (exact):** The Coach must NEVER claim an action is "correct"/"optimal"/"best"/
  "winning". The return type must have NO FIELD CAPABLE of saying so, verified at the type level
  AND by grepping emitted strings.
- **Status:** PASS
- **Implementation location:** `packages/contracts/src/api-types.ts:257-276`
- **Runtime evidence:** type level —

```ts
export interface CoachSuggestion {
  readonly action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  readonly sizeRange?: { readonly min: number; readonly max: number };
  readonly confidence: 'low' | 'moderate' | 'reasonable';
  readonly reason: string;
  readonly whatWouldChangeIt: readonly string[];
}
```

  There is no boolean, no verdict enum, no score. The confidence enum tops out at `reasonable` —
  there is no `certain`/`high`. `CoachReport.assumptions` and `.uncertainty` are non-optional.

  Emitted strings — I scanned every `.ts/.tsx/.json` under `packages/poker-math/src`,
  `packages/poker-ai/src`, `packages/ui/src`, `apps/web/src`, `apps/api/src`,
  `packages/content/data`, `packages/contracts/src` for
  `optimal|GTO|solver|solved|correct play|the correct|best play|the best action|right answer|
  guaranteed|winning play`. Every hit was one of: a comment describing the prohibition, a
  negation, an implementation term (`bézier solver`, `node:crypto`), a quiz **distractor**
  (`'Calling is the optimal play'` in `apps/web/src/fixtures/learn-quizzes.ts:384`, whose
  option-note is *"Optimal is a claim about every available action. You have compared two of
  them."*), or a bot's described leak. No Coach output string claims correctness.

  The two reason strings the Coach can actually emit (`coach.ts:800-802`) are:
  - low confidence: *"X comes out marginally ahead here, but only just — treat this as close to
    indifferent rather than as a recommendation."*
  - otherwise: *"X has the highest expected value against the stated range, by N chips over the
    next-best action."*

  Both are model-relative statements of fact, not correctness claims.

  A second, independent guard exists for the AI commentary:
  `packages/poker-ai/src/commentary.ts:272` rejects any generated prose containing
  `correct|incorrect|optimal|suboptimal|gto|solved|mistake|blunder|wrong`.
- **Test covering it:** `packages/contracts/test/contract-surface.test.ts`,
  `packages/ui/test/coach-panel-render.test.ts`, `packages/poker-ai/test/commentary.test.ts:346-460`
- **Test result:** contracts 21/21, ui 186/186, poker-ai 148/148 — all pass
- **Reviewer notes:** This is the best-defended requirement in the product. One borderline string:
  `apps/web/src/components/PostHandComparison.tsx:408` labels a comparison axis
  *"against the best action the analysis priced"*. It describes the model's own ranking rather
  than asserting the learner was wrong, so I did not treat it as a violation, but it is the one
  phrase in the shipped UI a reader could misread. P3.
- **Missing work:** none required.

## PROD-024 Content integrity — no hard-coded computed number in `packages/content`

- **Requirement (exact):** NEVER HARD-CODE A COMPUTED NUMBER. Content stores SITUATIONS; every
  equity / pot-odds / out-count / EV number is computed at runtime by `@prl/poker-math`.
- **Status:** PASS
- **Implementation location:** `packages/content/data/**` (409 KB);
  validator `packages/content/src/validate.ts` (1001 lines)
- **Runtime evidence:** I walked every file under `packages/content/data` with a script:

```
percent literals ( \d+(\.\d+)?% ) in packages/content/data : TOTAL 0
decimal 0.xx literals                                      : 0
ratio N:M literals                                         : 0
```

  The only number-adjacent prose found is deliberately spelled-out approximation teaching
  ("roughly one in fifty", "about two percent") attached to the rule-of-2-and-4 lesson, which
  guardrail §4 explicitly permits ("Approximations may be taught … but only labelled as
  approximations, alongside their actual error"). Quiz numeric answers store only a
  `calculation` + `field` + `unit` + `tolerance`; the target is computed per request (proved in
  PROD-003: `expected.value = 33.33333333333333`).
- **Test covering it:** `packages/content/test/scenarios.test.ts`
- **Test result:** 13/13 pass
- **Reviewer notes:** For the content package the rule holds cleanly. It does **not** hold for the
  web fixtures — see PROD-025.
- **Missing work:** none

## PROD-025 Content integrity — no hard-coded computed number in web copy/fixtures

- **Requirement (exact):** Same rule, applied to what the learner actually sees: no hard-coded
  probability/percentage in web copy.
- **Status:** **FAIL**
- **Implementation location:** `apps/web/src/fixtures/scenarios.ts:499, 500, 618, 642, 643, 762,
  961, 962, 1084`; `apps/web/src/fixtures/review.ts:452, 453, 576, 621, 622, 742`
- **Runtime evidence:** these fixtures hard-code whole `CoachReport`s, and three of the six
  bundled Lab scenarios have **drifted away from the engine**. I reproduced the comparison
  directly (same inputs, same seed 20260817, same 40 000 samples as `routes/content.ts`):

```
$ node fixdrift.ts
DRIFT  flop-flush-draw-price
        fixture ruleOfThumb: estimate=0.36  errorPoints=-2.4343434343434325
        engine  ruleOfThumb: estimate=0.36  errorPoints= 1.0323774283071216
DRIFT  turn-gutshot-price
        fixture ruleOfThumb: estimate=0.08  errorPoints=-1.0909090909090917
        engine  ruleOfThumb: estimate=0.08  errorPoints=-0.695652173913043
OK     preflop-set-mining-odds
DRIFT  flop-spr-commitment
        fixture ruleOfThumb: estimate=1.6   errorPoints=95.49187527448397
        engine  ruleOfThumb: estimate=null  errorPoints=null
        fixture outs: 2c/38d/40t   engine outs: 2c/38d/40t
OK     river-bluff-catch-range
OK     preflop-squeeze-fold-equity

SCENARIOS WITH DRIFTED STORED ANALYSIS: 3 of 6
```

  Three concrete lies now shipped:

  1. `flop-flush-draw-price` — **the sign of the error is inverted.** The fixture tells the
     learner *"The rule of 2 and 4 gives 36% here, **understating** the real figure by 2.4 points"*
     (`scenarios.ts:618`). The engine computes that it **overstates** by 1.0 points.
  2. `turn-gutshot-price` — magnitude wrong (1.1 points claimed vs 0.70 computed).
  3. `flop-spr-commitment` — the fixture publishes **a probability of 160%**:

```
apps/web/src/fixtures/scenarios.ts:962:
  '40 outs with two cards to come, times 4, is roughly 160% — the rule of 2 and 4. …
   The shortcut overstates by 95.5 points here — 160% against an exact 64.5%.'
apps/web/src/fixtures/scenarios.ts:1084:
  'The rule of 2 and 4 gives 160% here, overstating the real figure by 95.5 points.'
```

     The current engine refuses to emit this — `packages/poker-math/src/coach.ts:274-277` returns
     `{kind:'not-a-probability'}` when the out count's multiple exceeds 100 — so it returns
     `ruleOfThumb: null`. The hard-coded fixture still carries the 160%.

  And it reaches a reader. With my API stopped, the fixture path is what serves the page:

```
$ kill <api>; curl -s -o down_spr.html http://127.0.0.1:3400/lab/flop-spr-commitment
status=200 bytes=57848
$ grep -o "is roughly 160%[^\\]{0,120}" down_spr.html
is roughly 160% — the rule of 2 and 4. It works because one card off a stub of about 46 cards
is worth a little over 2%, so 2% per out ...
```

  `apps/web/src/fixtures/review.ts:453` has the same class of error in the Hand Review fixture: it
  computes the shortcut from **15 total outs (8 clean + 7 dirty)** to get 60%, inside a sentence
  that itself says *"Count clean outs only"*. The engine now uses the 8 clean outs and gets 32%.
- **Test covering it:** `apps/api/test/web-fixture-figures.test.ts:100` and `:230`
- **Test result:** **BOTH FAIL.**

```
✖ matches buildCoachReport for every bundled scenario
  AssertionError: flop-flush-draw-price's stored analysis is not what the engine computes now
✖ REVIEW_HAND_SHOWDOWN replays and analyses identically
  AssertionError: REVIEW_HAND_SHOWDOWN's stored analyses are not what buildHandReview computes now
```

  (Note: the loop aborts on the first mismatch, so the test reports 1 drifted scenario; my own
  run found 3.)
- **Reviewer notes:** This is exactly the failure mode the "never hard-code a computed number"
  rule exists to prevent, occurring in the one place the rule was not applied. The
  `packages/ui` guard `no percentage the panel renders is above 100%`
  (`coach-panel-render.test.ts:304`) passes because it renders its own inline fixture, not
  `apps/web/src/fixtures/scenarios.ts`.
- **Missing work:** regenerate all three fixtures from the engine; add a CI gate that fails on
  fixture drift (the test already exists — it just is not green); consider generating these
  fixtures at build time instead of checking in computed numbers.

## PROD-026 Content integrity — authored teaching point agrees with the computed suggestion

- **Requirement (exact):** A scenario whose teaching point stops being true must fail the build
  (`docs/PRODUCT-GUARDRAILS.md` §4). Corollary: the learner must not be told their answer is
  inconsistent with an analysis that the scenario's own prose contradicts.
- **Status:** **FAIL**
- **Implementation location:** `packages/content/src/validate.ts` (verifies `expectedInsight`
  only); `apps/api/src/routes/content.ts:994-1020` (attempt grading via `judgeConsistency`)
- **Runtime evidence:** the machine-verified `expectedInsight` claims still hold — but they are
  narrow (`equityExceedsBreakEven`, `callEvSign`, `cleanOutsEquals`), and nothing verifies that
  the authored `reasoning` agrees with the published `suggestion`. It frequently does not:

```
$ node contradict.mjs
TOTAL scenarios: 36
scenarios where the suggested action word does not appear in the scenario's own question: 24
```

  That 24 is a keyword heuristic and a few of them are arguable (a question phrased
  "enter the pot or fold" does arguably admit a raise). The hard cases are not arguable at all.
  The clearest, `rk-the-fold-that-feels-wrong` (topic: risk-psychology, title "Folding top
  pair, top kicker"):

```
Question:  "Should hero call or fold the big river bet?"
Reasoning: "…against the range described the price asks for more than your share of the pot,
            so folding is better than calling."
expectedInsight: [breakEvenExceedsEquity, callEvSign:negative]      <- both true
Candidates: fold ev=0.00   call ev=-183.33   raise to 560 ev=+126.50
Suggestion: raise / reasonable
```

  A learner who folds — the answer the lesson teaches, and the only sensible one of the two the
  question offers — is told:

```
$ POST /api/v1/content/scenarios/rk-the-fold-that-feels-wrong/attempt {"action":"fold"}
"reasoning": "fold is not consistent with this analysis. … Measured against folding — which is
  worth exactly zero — it comes out about 126.5 chips behind, more than the 20.0 chips (one big
  blind) this spot treats as indifferent. Against this range the analysis also supports raise,
  so this spot does not come down to one answer. … Read the board back before you read your
  hand. … against the range described the price asks for more than your share of the pot, so
  folding is better than calling."
```

  The same response tells the learner in one sentence that folding is not consistent with the
  analysis, and in the next that folding is better than calling. The `raise to 560` that drives
  the verdict is a river bluff-shove credited with 35% fold equity against a range the scenario
  itself describes as full houses.

  Second example, `eq-flush-draw-turn-small-bet`: the authored reasoning says
  *"Raising is a different plan with a different justification — it needs the opponent to fold
  hands that beat you — and nothing in this range assumption supports it."* The suggestion is
  `raise` at `reasonable` confidence.

  Across the set, the Coach suggests `raise` in **26 of 36** authored teaching spots.
- **Test covering it:** NONE. `packages/content/test/scenarios.test.ts` checks `expectedInsight`
  only.
- **Test result:** those tests pass, which is why this shipped.
- **Reviewer notes:** Part of this is downstream of PROD-020 (illegal raises inflating the
  candidate set) and part is the flat 35% fold-equity assumption applied to every aggressive line
  regardless of the opponent range. Either way, the product's central promise — that it teaches
  reasoning and reports whether a decision was consistent with the analysis — is being broken on
  its own flagship examples.
- **Missing work:** fix PROD-020; make the fold-equity assumption a function of the stated range;
  add a content check that the suggested action is one the scenario's question offers.

## PROD-027 Progress — quiz/scenario/hand progress persists

- **Requirement (exact):** Progress actually persists (guest + DB).
- **Status:** PARTIAL
- **Implementation location:** `apps/api/src/repositories/progress.ts`;
  `apps/api/src/routes/progress.ts:97`
- **Runtime evidence:** after driving the API as a guest (3 quiz questions, 3 scenario attempts,
  5 completed hands):

```
$ curl -s -b jar.txt http://127.0.0.1:3401/api/v1/me/progress
{ "lessonsCompleted": [],
  "scenariosAttempted": ["rk-the-fold-that-feels-wrong"],
  "quizQuestionsAnswered": 3,
  "handsPlayed": 5,
  "unitsNetLifetime": 140,
  "topicsTouched": ["risk-psychology"] }

$ psql -c "select count(*) from prl.quiz_attempts where user_id='usr_cbxin…'"      -> 5
$ ... scenario_attempts -> 3
$ ... lesson_progress   -> 0
```

  `unitsNetLifetime: 140` matches the hero stack I finished on (1140 from 1000). Guest identity is
  a real `prl.users` row keyed by the `prl_session` cookie, so guest progress is DB-backed.
- **Test covering it:** `apps/api/test/repositories.test.ts:1469-1590`
- **Test result:** pass
- **Reviewer notes:** PARTIAL, not PASS, for three reasons: (a) `lessonsCompleted` can never be
  non-empty (PROD-028); (b) `quizQuestionsAnswered` will always be 0 for a real user of the web
  app, because the client never submits (PROD-004); (c) `GET /me/progress` is not in `API_PATHS`
  and is called by nothing in `apps/web`, so no progress figure is ever displayed to a learner.
- **Missing work:** wire the quiz submission, add a lesson-read write path, add `progress` to
  `API_PATHS` and surface it.

## PROD-028 Progress — lesson completion persists

- **Requirement (exact):** Lessons read/completed are recorded.
- **Status:** **FAIL**
- **Implementation location:** `apps/api/src/repositories/progress.ts:93`
  (`upsertLessonProgress`) and `:131` (`clearLessonProgress`) — called by **no route**.
- **Runtime evidence:**

```
$ grep -rn "upsertLessonProgress|clearLessonProgress" apps/api/src packages
apps/api/test/repositories.test.ts:1469 …   (tests only)
apps/api/src/repositories/progress.ts:93  … (the definitions)
apps/api/dist/repositories/progress.d.ts:63 … (the build output)
— no call site in any route, ws handler or worker.

$ curl -s -b jar.txt http://127.0.0.1:3401/api/v1/content/lessons   (with a session, after reading)
hand-flow:false, betting-actions:false, position-basics:false, reading-the-board:false,
counting-outs:false, pot-odds:false, expected-value:false, fold-equity:false, bet-sizing:false,
stack-to-pot-ratio:false, variance:false, all-ins-and-side-pots:false, blinds-and-the-option:false,
rule-of-2-and-4:false, ranges-and-combos:false, sample-size-and-risk-of-ruin:false,
tournament-chips-and-icm:false

$ psql -c "select count(*) from prl.lesson_progress"  (for my user)  -> 0
```

  `LessonSummary.completed` is a field that is wired end-to-end — schema, repository, response
  type, and the `/learn` index reads it — and is structurally always `false`, forever, for every
  learner. `prl.lesson_progress` is a table nothing writes to.
- **Test covering it:** `apps/api/test/repositories.test.ts:1469` tests the repository function
  directly. Nothing tests that any route calls it.
- **Test result:** repository tests pass; the product path does not exist.
- **Reviewer notes:** Another tested-library / unwired-product case. Note the same shape as
  PROD-004, PROD-009 and PROD-016 — this codebase's recurring defect is a well-tested capability
  with no call site.
- **Missing work:** add `POST /content/lessons/:id/read` (or equivalent) and a client call.

## PROD-029 Guardrails — no money, purchase, cash-out, transfer, prizes, crypto, affiliate

- **Requirement (exact):** No real money, no purchase path, no cash-out, no transferable chips,
  no prizes, no crypto, no affiliate links, no gambling claims.
- **Status:** PASS
- **Implementation location:** `db/migrations/0001_initial.sql` (schema),
  `apps/api/src/repositories/users.ts:17-18`, `apps/web/src/app/page.tsx:180`,
  `apps/web/src/components/SiteFooter.tsx:62`
- **Runtime evidence:** LIVE schema — `prl.users` has no value column at all:

```
$ psql -c "select column_name, data_type from information_schema.columns
           where table_schema='prl' and table_name='users'"
id text | kind text | display_name text | oidc_issuer text | oidc_subject text
| last_seen_at timestamptz | created_at timestamptz | updated_at timestamptz
```

  No `units`, `balance`, `currency`, `price` or `payout` column anywhere in the `prl` schema;
  units are derived from live seats. There is no transfer endpoint (full route table in PROD-040).

  Shipped copy — I stripped tags from all 11 rendered pages and scanned for
  `deposit|top-up|cash out|withdraw|purchase|buy chips|cashier|wallet|real money|credit card`,
  `prize|jackpot|sweepstake|redeem|giveaway`, `bitcoin|ethereum|NFT|crypto|web3`,
  `affiliate|referral bonus|promo code`. Every hit was a disclaimer or ICM teaching text:

```
page_.html      : "Practice units only · no real money"
page_.html      : "Not a gambling product — There is no real money in this app. Chips are units:
                   free practice counters with …"
every page      : "…it is not a gambling product: there is no real money in it, nothing to buy,
                   nothing to win and no way …"
page_learn.html : "Once a payout schedule exists, chips convert to prize equity along a curve…"
                  (the ICM lesson summary)
```

  Zero crypto, zero affiliate, zero purchase paths in rendered output.
- **Test covering it:** `apps/api/test/repositories.test.ts`, `apps/api/scripts/verify-schema.mjs`
- **Test result:** pass
- **Missing work:** none

## PROD-030 Guardrails — units free / resettable / valueless

- **Requirement (exact):** Chips are free, resettable at will by the user, and valueless.
  "Reset is always available and never penalised."
- **Status:** PARTIAL
- **Implementation location:** endpoint `apps/api/src/routes/auth.ts:526`
  (`POST /me/units/reset`); badge `packages/ui/src/components/UnitsBadge.tsx:47`
- **Runtime evidence:** the endpoint works and is unconditional:

```
$ curl -s -b jar.txt -X POST -H "x-csrf-token: …" -H "content-length: 0" \
    http://127.0.0.1:3401/api/v1/me/units/reset
{"units":1000}   status=200
```

  The badge copy is in the shipped HTML on every page:

```
"Units are free practice chips. They have no monetary value, they cannot be bought, sold,
 transferred or cashed out, and you can reset them to the starting amount at any time."
```

  But there is **no reset control anywhere in the web app**:

```
$ grep -rni "reset" apps/web/src/components/SiteHeader.tsx apps/web/src/app/play/*.tsx \
    packages/ui/src/components/UnitsBadge.tsx | grep -v "resettable|reset them"
(no control, no handler, no call site)

$ grep -rn "API_PATHS\." apps/web/src | grep -i reset
(no matches — `unitsReset` is not even in API_PATHS)
```
- **Test covering it:** `apps/api/test/auth.test.ts` (endpoint)
- **Test result:** pass
- **Reviewer notes:** The product tells the learner, on every page, that they can reset their units
  at any time, and gives them no way to do it. That is a guardrail whose enforcement point — the
  UI — is missing, and it is also a false statement in shipped copy.
- **Missing work:** add a reset control (and `unitsReset` to `API_PATHS`), or change the badge copy.

## PROD-031 Guardrails — no casino dark patterns

- **Requirement (exact):** No loss-chasing, streak pressure, "you're due", near-miss celebration,
  urgency, FOMO, variable-reward framing, XP/levels/badges/leaderboards.
- **Status:** PASS
- **Implementation location:** design decisions documented at
  `apps/web/src/app/learn/page.tsx:15-26`, `apps/web/src/app/lab/page.tsx:23-26`,
  `apps/web/src/components/ScenarioStage.tsx:24`, `apps/web/src/components/QuizRunner.tsx:8`
- **Runtime evidence:** I scanned both the **source** (`apps/web/src`, `packages/ui/src`,
  `packages/content/data`, `packages/poker-ai/src`, `apps/api/src`) and the **rendered HTML of all
  11 pages** for ten dark-pattern families. Every source hit was a negation, a design comment, or
  a teaching device:

```
LOSS-CHASING  packages/content/data/quizzes.json:1173  "You are due for it to hold up soon"
              -> a quiz DISTRACTOR (the gambler's fallacy, presented to be rejected)
SUNK COST     packages/content/data/scenarios/risk-and-sizing.json:468
              "Calling because of the chips already invested. Money in the pot has no owner…"
              -> listed under commonMistakes
STREAK        38 hits, all of the form "there is no mark, no total and no streak anywhere in
              this app", "no score threshold", "no pass mark", "no leaderboard"
```

  Rendered-HTML scan across all pages found zero urgency, zero FOMO, zero near-miss framing, zero
  XP/level/badge/leaderboard, and only one `STREAK` hit — the negation
  *"there is no mark, no total and no streak anywhere in this app"* on the scenario page.

  Schema-level enforcement confirmed against the LIVE database — there is nowhere to store a
  score or a streak:

```
$ psql -c "select table_name, column_name, data_type from information_schema.columns
           where table_schema='prl' and table_name in
                 ('quiz_attempts','scenario_attempts','lesson_progress')"
quiz_attempts:     id, user_id, quiz_id, question_id, answer jsonb, was_correct boolean, created_at
scenario_attempts: id, user_id, scenario_id, chosen_action jsonb, matched_expected boolean, created_at
lesson_progress:   id, user_id, lesson_id, completed_at, last_viewed_at, created_at, updated_at
```

  `was_correct` is per question with no aggregate anywhere; `matched_expected` is nullable by
  design (left NULL when the analysis does not support a single action).
- **Test covering it:** `packages/ui/test/coach-panel-render.test.ts` asserts on reader-visible
  strings; `apps/api/test/content-routes.test.ts` covers the no-score attempt responses.
- **Test result:** pass
- **Reviewer notes:** Genuinely, unusually clean. The design is anti-gamified on purpose and it
  shows in both the source and the shipped bytes.
- **Missing work:** none

## PROD-032 Guardrails — no public matchmaking, no chat

- **Requirement (exact):** No public matchmaking or lobby of strangers. No free-text chat.
- **Status:** PASS
- **Implementation location:** `packages/contracts/src/ws-protocol.ts:135`;
  `apps/api/src/routes/rooms.ts:291`
- **Runtime evidence:** the WebSocket client-message union is closed and contains no chat frame:

```ts
export type WsClientMessage = WsHello | WsSit | WsStand | WsAction | WsRequestCoach
                            | WsStartHand | WsPing;
```

  and the schema (`packages/contracts/src/schemas.ts:313-388`) is a `oneOf` over exactly those
  seven with `additionalProperties: false` on each — an unrecognised frame is refused before the
  router sees it (`apps/api/src/ws/router.ts:264`). `GET /rooms` returns only
  `store.listForUser(principal.userId)` — rooms the caller owns or is seated at. There is no
  browse/search/matchmake endpoint in the whole route table (PROD-040). No avatar or upload
  surface exists. Grepping shipped source for `chat|lobby|matchmaking|public table` produced 3
  hits, all incidental comments.
- **Test covering it:** `apps/api/test/ws-router.test.ts`, `apps/api/test/rooms.test.ts`
- **Test result:** pass
- **Missing work:** none

## PROD-033 Guardrails — `rooms.visibility` CHECK-constrained in the LIVE schema

- **Requirement (exact):** `rooms.visibility` has a CHECK constraint permitting exactly
  `'invite_only'`, verified against the live schema.
- **Status:** PASS
- **Implementation location:** `db/migrations/0002_indexes_and_constraints.sql`
- **Runtime evidence:** queried the running container, not the migration file:

```
$ docker exec … psql -U poker -d poker_risk_lab -c \
   "select conname, pg_get_constraintdef(oid) from pg_constraint
    where conrelid='prl.rooms'::regclass and contype='c'"
rooms_visibility_invite_only :: CHECK ((visibility = 'invite_only'::text))
```

  And proved it actually bites, inside a rolled-back transaction:

```
$ psql -c "begin; update prl.rooms set visibility='public' where id='room_txksaeq…'; rollback;"
ERROR:  new row for relation "rooms" violates check constraint "rooms_visibility_invite_only"
DETAIL:  Failing row contains (room_txksaeq…, Audit Table A, …, public, open, …).
```
- **Test covering it:** `apps/api/test/repositories.test.ts`;
  `apps/api/scripts/verify-schema.mjs`
- **Test result:** pass
- **Reviewer notes:** The transaction was rolled back; the shared database was not mutated.
- **Missing work:** none

## PROD-034 AI Legends — generic-archetype naming by default

- **Requirement (exact):** Strategy profiles of STYLES, not impersonations: generic-archetype
  naming by default.
- **Status:** PASS
- **Implementation location:** `packages/poker-ai/src/labelling.ts:63-77` (`resolveNamingMode`);
  `apps/api/src/routes/rooms.ts:363`
- **Runtime evidence:** with no configuration set, the live API returns archetype names and
  `attributed: false` for all 12 profiles:

```
$ curl -s http://127.0.0.1:3401/api/v1/legends/profiles
profiles: 12
 vocal-aggressor, adaptive-exploiter, patient-technician, reading-pressure-specialist,
 old-school-pressure, mixed-game-generalist, volume-grinder, disciplined-specialist,
 foundational-reader, range-narrator, fundamentals-coach, calling-station

first profile disclosure:
 { "displayName": "High-Variance Tournament Aggressor",
   "archetypeName": "High-Variance Tournament Aggressor",
   "tagline": "Plays a lot of hands, applies constant pressure, and hates folding.",
   "attributed": false,
   "disclaimers": ["These opponents are educational strategy simulations. … They are not real
     people, not digital copies of anyone, and not endorsed by anyone."] }
```

  Bots seated at my table rendered as "Calling Station" and "Disciplined Specialist".
  `resolveNamingMode` returns `'archetype'` when `PRL_LEGEND_NAMING` is unset or empty and throws
  on any value other than `archetype`/`attributed` — the permissive mode is never the default and
  cannot be reached by a typo.
- **Test covering it:** `apps/api/test/legends-naming-fallback.test.ts`,
  `apps/api/test/legend-fixture-figures.test.ts`
- **Test result:** pass
- **Reviewer notes:** One governance gap worth naming: the repo hard-codes ten real living
  people's names as `attributedName` (`packages/poker-ai/src/profiles.ts:151, 197, 243, 289, 335,
  381, 427, 473, 519, 565`), and the switch that reveals them — `PRL_LEGEND_NAMING` — is
  **not documented in `.env.example` at all** (`grep -n PRL_LEGEND_NAMING .env.example` → no
  match), even though that file is 15 KB and documents every other variable including which ones
  are deliberately absent. The one variable with name/image/likeness consequences is the one
  variable the environment example does not mention. P2.
- **Missing work:** document `PRL_LEGEND_NAMING` in `.env.example` with the NIL warning.

## PROD-035 AI Legends — no mental-state verbs, no endorsement claim

- **Requirement (exact):** No mental-state verbs attached to a name; no claim of endorsement or
  affiliation.
- **Status:** PASS
- **Implementation location:** `packages/poker-ai/src/commentary.ts:257-280` (`VOICE_PATTERNS`),
  `:292` (`assertModelVoice`); `packages/poker-ai/src/labelling.ts:85-101` (disclaimers)
- **Runtime evidence:** the guard is a hard reject list applied to every generated string:

```ts
{ pattern: PERSON_NAME_PATTERN,                     why: 'names a person…' },
{ pattern: /\b(?:he|him|his|she|her|hers|himself|herself)\b/iu,   why: 'personal pronoun…' },
{ pattern: /\b(?:i|me|my|mine|myself|we|us|our|ours)\b/iu,        why: 'first-person pronoun…' },
{ pattern: /\b(?:correct|…|optimal|…|gto|solved|mistake|blunder|wrong)\b/iu, why: 'verdict…' },
{ pattern: /\b(?:thinks?|feels?|believes?|senses?|intends?|wants?|remembers?)\b/iu,
  why: 'attributes a mental state; a model weights, prefers, treats and scores, it does not think' }
```

  Every profile served carries the universal disclaimer verbatim ("…not real people, not digital
  copies of anyone, and **not endorsed by anyone**"), and the attributed mode adds a second one
  ("…**not affiliated with or approved by them**, and nothing here should be read as representing
  their views").
- **Test covering it:** `packages/poker-ai/test/commentary.test.ts:346, 368, 410, 426, 503, 646`
  — including *"the shared pattern list catches a name plus a mental-state verb"* and
  *"explainModelDecision never impersonates, over every profile and every offered action"*.
- **Test result:** `packages/poker-ai` 148/148 pass
- **Missing work:** none

## PROD-036 AI Legends — behaviour probabilistic, not scripted

- **Requirement (exact):** Behaviour is probabilistic, not scripted.
- **Status:** PASS
- **Implementation location:** `packages/poker-ai/src/policy.ts`, `packages/poker-ai/src/traits.ts`
- **Runtime evidence:**

```
$ pnpm run test:simulation
ℹ tests 23   ℹ pass 23   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0   ℹ todo 0
EXIT=0
```

  The suites do real statistics, not shape checks. Excerpts from the actual output:

```
0 divergence(s) across 12 profiles:
  vpip: mean signed +0.0132, 1/12 below declared, tolerance 0.05
  aggressionFrequency: mean signed +0.0264, 4/12 below declared, tolerance 0.18
  threeBetTendency: mean signed -0.0023, 6/12 below declared, tolerance 0.15
  (sampling half-width at 8000 hands: 0.0110)

VPIP calling-station vs disciplined-specialist: 3139/6194 = 0.507 against 980/6194 = 0.158;
  pooled 0.332, standard error 0.00847, z = 41.175
AF   reading-pressure-specialist vs calling-station: 0.670 against 0.132; z = 59.399
VPIP separated 61/66 pairs at alpha = 0.001
indistinguishable on VPIP alone: vocal-aggressor/foundational-reader,
  adaptive-exploiter/foundational-reader, reading-pressure-specialist/range-narrator,
  old-school-pressure/volume-grinder, mixed-game-generalist/volume-grinder
Spearman rho (declared vs observed VPIP) = 1.0000 ; PFR = 0.9860 ; aggression = 0.9510
cross-seed Spearman rho (observed VPIP) = 0.9930
```

  Suites: `declared-versus-observed.test.ts`, `profile-differentiation.test.ts`,
  `sampler-calibration.test.ts`. Observed at runtime over the socket: the same two bot profiles
  produced different lines across four hands from the same seats.
- **Test covering it:** the three simulation suites above
- **Test result:** 23/23 pass, 0 skipped
- **Reviewer notes:** The output is honest about its own limits — it names three trait axes whose
  bias is "one-sided but undiagnosed, inside tolerance", and it names the five profile pairs that
  are *not* separable on VPIP alone rather than claiming twelve distinct styles. That is the
  behaviour of a suite that is measuring rather than decorating.
- **Missing work:** none

## PROD-037 AI Legends — reads only what a human in the same seat could read

- **Requirement (exact):** The AI must read only what a human in the same seat could read — no
  hidden cards, no future deck.
- **Status:** PASS
- **Implementation location:** `apps/api/src/rooms/bots.ts:8-11, 250, 261-282`;
  `packages/poker-engine/src/redact.ts`; `packages/poker-ai/src/policy.ts`
- **Runtime evidence:** `bots.ts` takes a redacted `PlayerView` and nothing else
  (`apps/api/src/rooms/bots.ts:250 readonly view: PlayerView`), and reads its own cards only from
  `view.seats[…].holeCards` for the seat the view was built for (`:274`). The proof is not by
  inspection — `packages/poker-ai/test/no-hidden-information.test.ts` runs four escalating
  assertions with 36 `assert.*` calls:

  1. `PolicyInput` has seven keys, none of them `HandState`; the whole input is serialised and
     walked, so the claim is about the object that existed, not the type.
  2. Every card in the serialised input is checked against the engine's own
     `cardsHiddenFrom(state, seat)`.
  3. The view is wrapped in a `Proxy` recording every property path read at every depth while
     `decide` runs for real; the read set must contain **no `holeCards` path at all**.
  4. Two hands differing only in an opponent's hole cards and the undealt deck must produce a
     byte-identical decision.

  Complementary suites: `packages/poker-engine/test/hidden-information.test.ts`,
  `packages/poker-engine/test/redaction-identity.test.ts`,
  `apps/api/test/hidden-information-api.test.ts`, `apps/api/test/seat-reuse-identity.test.ts`.
- **Test covering it:** the five suites above
- **Test result:** `packages/poker-ai` 148/148, `packages/poker-engine` 119/119, and the API
  hidden-information tests all pass (within 532/534).
- **Reviewer notes:** Proof-by-instrumentation rather than proof-by-reading. This is the strongest
  evidence in the repository.
- **Missing work:** none

## PROD-038 Silent fixture-fallback regression is genuinely fixed

- **Requirement (exact):** The web app must really talk to the API and must NOT silently serve
  bundled fixture data when the API is absent or failing. (Previously a P0.)
- **Status:** PASS
- **Implementation location:** `packages/contracts/src/api-paths.ts` (the shared path table);
  `apps/web/src/lib/api.ts:isApiUnavailable` / `isMissingResource`;
  `apps/web/src/lib/learn-data.ts`; `apps/web/src/app/learn/page.tsx:158-162`
- **Runtime evidence:** **API up** — the pages serve live data, distinguishable from the fixture
  by size:

```
$ curl -s http://127.0.0.1:3400/lab   | count distinct /lab/<id> links   -> 36   (fixture has 6)
$ curl -s http://127.0.0.1:3400/learn | count distinct /learn/<id> links -> 18   (17 + glossary)
$ curl -s http://127.0.0.1:3400/review  (with session cookie)
   lists exactly my five real hand ids from Postgres, no fixture marker
$ /legends, /legends/vocal-aggressor, /legends/compare, /legends/hand-review -> 200, 0 fixture notices
```

  **API killed** — the fallback happens, and it is loudly labelled every time:

```
$ kill <api>; curl http://127.0.0.1:3400/learn
   /lab scenario count drops 36 -> 6
   banner: "This index is not live — The content service is not reachable, so this index is
            listing the bundled copy of the curriculum. The lessons and their prerequisites are
            real; the read/unread marks are not yours. (GET /api/v1/content/lessons failed with
            status 503)"
$ curl http://127.0.0.1:3400/learn/pot-odds
   "…not reachable, so this lesson is the bundled copy. Every figure in it is still computed
    here, from the maths package… (could not reach the API at http://127.0.0.1:3401…)"
$ curl http://127.0.0.1:3400/lab
   "…not reachable, so this list comes from the typed fixture in …"
$ curl http://127.0.0.1:3400/legends
   "…not reachable, so this page is rendering the bundled sample profiles… treat nothing here
    as a live figure. (could not reach the API at http://127.0.0.1:…)"
$ curl http://127.0.0.1:3400/lab/eq-flush-draw-turn-small-bet
   -> 404   (the fixture does not carry that scenario; an honest not-found, not a substitute)
$ curl http://127.0.0.1:3400/lab/flop-spr-commitment
   -> 200 with "…not reachable, so this page is rendered from <code>…"
```

  The prefix itself is correct end-to-end: every path in `API_PATHS` carries `/api/v1`, and the
  browser-side rewrite resolves (`GET http://127.0.0.1:3400/api/v1/auth/session -> 200`,
  `GET http://127.0.0.1:3400/api/v1/content/lessons -> 17 lessons`).
- **Test covering it:** `apps/api/test/web-api-paths.test.ts:180-259` (every path resolves; the
  pre-fix paths all 404) and `:312-330` (no literal `/api` string anywhere in `apps/web/src`)
- **Test result:** pass
- **Reviewer notes:** This specific regression is genuinely fixed and I could not reproduce it.
  The remaining risk is not silence but *content*: the fixture the fallback serves contains
  demonstrably wrong maths (PROD-025). A correctly-labelled fixture that teaches a 160%
  probability is still a defect, just an honest one.
- **Missing work:** none for the fallback mechanism.

## PROD-039 Release candidate's own test suite is green

- **Requirement (exact):** The implementation is claimed complete; its own tests should pass.
- **Status:** **FAIL**
- **Implementation location:** n/a
- **Runtime evidence:**

```
$ pnpm run test:unit
packages/content      tests 13   pass 13   fail 0   skipped 0
packages/contracts    tests 21   pass 21   fail 0   skipped 0
packages/poker-ai     tests 148  pass 148  fail 0   skipped 0
packages/poker-engine tests 119  pass 119  fail 0   skipped 0
packages/poker-math   tests 232  pass 232  fail 0   skipped 0
packages/ui           tests 186  pass 186  fail 0   skipped 0
apps/web              tests 22   pass 22   fail 0   skipped 0
EXIT=0                (741 total, 0 skipped)

$ pnpm --filter @prl/api test
ℹ tests 534   ℹ suites 119   ℹ pass 532   ℹ fail 2   ℹ skipped 0   ℹ todo 0
✖ failing tests:
  test/web-fixture-figures.test.ts:100  ✖ matches buildCoachReport for every bundled scenario
  test/web-fixture-figures.test.ts:230  ✖ REVIEW_HAND_SHOWDOWN replays and analyses identically
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] Exit status 1
EXIT=1

$ pnpm run test:simulation
ℹ tests 23   ℹ pass 23   ℹ fail 0   ℹ skipped 0
EXIT=0
```
- **Reviewer notes:** 1 298 tests run, 0 skipped, 0 vacuous that I found — the suite is
  substantial and it asserts. Two tests fail, and they are the two that guard the release-blocking
  content-integrity rule. `pnpm run verify` (which chains `test`) therefore cannot pass on this
  tree. The claim that the implementation is complete is not supported by the repository's own
  gate.

  One thing I suspected and **cleared**, recorded so nobody repeats it: `@prl/poker-math` resolves
  to `packages/poker-math/dist/index.js` for both the API server and the test runner, and `dist`
  has an older mtime than `src`. I checked whether the shipped build had drifted from source by
  running `buildCoachReport` from both over all 36 scenarios:

```
$ node distvssrc.ts
dist vs src identical: 36  differing: 0
```

  The build is current. The two failures are genuine fixture drift, not a stale artefact.
- **Missing work:** regenerate the two fixtures (see PROD-025) and re-run `pnpm run verify`.

## PROD-040 Every registered API route is reachable from the product

- **Requirement (exact):** `API_PATHS` "is the only place a request path may be constructed" and
  "the table is the whole surface, deliberately"
  (`packages/contracts/src/api-paths.ts` header).
- **Status:** **FAIL**
- **Implementation location:** `packages/contracts/src/api-paths.ts` (17 entries);
  `apps/api/src/routes/*.ts` (24 registered routes)
- **Runtime evidence:** registered routes, extracted from the route modules:

```
GET  /auth/session          POST /auth/guest           POST /auth/logout
GET  /auth/oidc/start       GET  /auth/oidc/callback
GET  /content/lessons       GET  /content/lessons/:id  GET  /content/scenarios
GET  /content/scenarios/:id GET  /content/glossary
POST /content/quizzes/:id/attempt   POST /content/scenarios/:id/attempt
GET  /hands                 GET  /hands/:handId
GET  /legends/profiles      GET  /legends/profiles/:profileId
GET  /legends/profiles/:profileId/stats
POST /legends/matches       POST /legends/compare
GET  /me/progress           POST /me/units/reset
POST /math/equity           POST /math/coach
GET  /rooms                 POST /rooms   POST /rooms/join
GET  /rooms/:roomId         POST /rooms/:roomId/sit   POST /rooms/:roomId/leave
UPGRADE /ws
```

  Absent from `API_PATHS`, therefore unreachable from `apps/web` by that file's own rule:
  `POST /auth/logout`, `POST /me/units/reset`, `GET /me/progress`, `POST /math/equity`,
  `POST /math/coach`, `POST /rooms/join`, `GET /rooms/:roomId`, `POST /rooms/:roomId/leave`,
  `POST /legends/matches`. In `API_PATHS` but never called: `quizAttempt`.
- **Test covering it:** `apps/api/test/web-api-paths.test.ts` — asserts only that every path the
  client can emit is registered, and that the client builds no path outside the table. It does not
  assert the converse.
- **Test result:** passes, and therefore does not catch this.
- **Reviewer notes:** The consequences are the individual product failures already recorded:
  no sign-out (PROD-030 context), no units reset (PROD-030), no progress display (PROD-027),
  no custom scenarios (PROD-009), no invite-code join (PROD-011), no quiz recording (PROD-004).
  Listing it as one requirement makes the shared root cause visible.
- **Missing work:** add a test asserting every registered route is either named in `API_PATHS` or
  explicitly listed as server-only, and add a test asserting every `API_PATHS` entry has a call
  site in `apps/web/src`.

---

## Counts

| Status | Count |
|---|---|
| PASS | 26 |
| FAIL | 10 |
| PARTIAL | 4 |
| UNVERIFIED | 0 |
| N/A | 0 |
| **Total** | **40** |

**FAIL (10):** PROD-004 (quiz attempts never submitted), PROD-009 (no custom scenarios),
PROD-011 (no invite-code join), PROD-016 (ICM never computed for a learner),
PROD-020 (Coach prices illegal actions), PROD-025 (hard-coded computed numbers in web fixtures,
drifted), PROD-026 (scenario prose contradicts the published suggestion),
PROD-028 (lesson completion never written), PROD-039 (2 failing tests in the release candidate),
PROD-040 (nine registered routes unreachable from the product).

**PARTIAL (4):** PROD-015 (tournament content but no tournament flow),
PROD-021 (size "range" usually a single number; suggestion drawn from an illegal candidate set),
PROD-027 (progress persists in the DB but two of its four figures can never be non-zero and none
is displayed), PROD-030 (reset endpoint works; no UI control, and the badge claims otherwise).

---

## Severity-classified issues

### P0 — release catastrophe (correctness of the product's central claim)

**P0-1 — The Coach recommends actions the poker engine forbids, in 4 of its 5 surfaces.**
`CoachInput.legalActions` is optional (`packages/poker-math/src/coach.ts:153`) and defaults to
"everything is legal" (`:556`). Only the live-table path supplies it
(`apps/api/src/ws/router.ts:653`). The wire type used by every other surface —
`CoachTask` in `apps/api/src/workers/equity-worker.ts:105-120` — **has no field for it**, so the
Scenario Lab (`routes/content.ts:363`), `POST /math/coach` (`routes/calc.ts:172`), Hand Review
(`review/build-review.ts:744`) and Legends compare (`rooms/bots.ts:830`) cannot pass it.
Measured: 3 shipped scenarios leave no opponent with chips behind, and 2 of them
(`eq-set-on-connected-flop-jam` raise to 320 EV 212.9; `eq-rule-of-four-big-draw-flop` raise to
260 EV 123.6) publish that illegal raise as the headline suggestion at `reasonable` confidence,
priced with 35% fold equity against a player who cannot fold. A third,
`rk-nine-big-blinds-call-or-fold`, suggests raise to 10 800 against one all-in seat and one the
prose says has folded. The engine explicitly refuses aggression in that state
(`packages/poker-engine/src/betting.ts:192-227`).
`packages/poker-math/test/coach-legality.test.ts` exists precisely to prevent this, describes this
exact bug in its header, and **passes** — because it supplies `legalActions` itself instead of
driving the production wire type.

**P0-2 — Shipped teaching content contradicts itself; a learner is told the taught answer is wrong.**
In 24 of 36 scenarios the suggested action word does not appear in the scenario's own question
(keyword heuristic; a handful are arguable). The unarguable case: in
`rk-the-fold-that-feels-wrong` the question is "call or fold", the authored reasoning concludes
"folding is better than calling", the machine-verified `expectedInsight` agrees
(`breakEvenExceedsEquity`, `callEvSign: negative`) — and `POST …/attempt {"action":"fold"}` answers
**"fold is not consistent with this analysis"** before repeating the prose that says folding is
better. Root cause is P0-1 plus a flat 35% fold-equity assumption applied to every aggressive line
regardless of the stated range. `packages/content/src/validate.ts` verifies `expectedInsight` only,
so the build stays green.

**P0-3 — Bundled fixtures ship wrong maths, including a 160% probability.**
3 of 6 Lab fixtures and the showdown Hand Review fixture have drifted from the engine.
`apps/web/src/fixtures/scenarios.ts:962` ships *"40 outs with two cards to come, times 4, is roughly
**160%**"* and `:1084` *"The rule of 2 and 4 gives 160% here"*; the current engine returns
`ruleOfThumb: null` for that spot. `:618` inverts the sign of the error ("understating by 2.4
points" where the engine computes "overstating by 1.0"). `apps/web/src/fixtures/review.ts:453`
computes the shortcut from 15 total outs inside a sentence that says "count clean outs only".
These are served to any learner whenever the API is unavailable — verified:
`GET http://127.0.0.1:3400/lab/flop-spr-commitment` with the API down returns the 160% string.
This is the "never hard-code a computed number" release-blocking rule broken in the one place it
was not applied, and it is caught by two tests that are currently **failing**.

### P1 — required feature broken or missing

- **P1-1 (PROD-011)** Private multiplayer is unreachable. `POST /rooms/join` exists; the web app
  never shows the invite code and has no join flow. Two independent humans cannot play.
- **P1-2 (PROD-004)** Quiz attempts are never submitted. `QuizRunner` grades client-side only;
  `quizAttempt` is the sole `API_PATHS` entry with no call site. `prl.quiz_attempts` stays empty
  for real users.
- **P1-3 (PROD-028)** Lesson completion is never written. `upsertLessonProgress` has no call site
  outside tests; `LessonSummary.completed` is structurally always `false`.
- **P1-4 (PROD-016)** ICM is never computed for a learner. `icmEquity` / `icmVsChipEv` /
  `pushFoldChipEv` have zero consumers; `LiveCalculation` has no `icm` variant; the two tournament
  scenarios are analysed on pure chip EV — including the one whose title is
  "when survival outweighs chip EV".
- **P1-5 (PROD-039)** The repository's own test gate is red: 2 failing tests in
  `apps/api/test/web-fixture-figures.test.ts`, so `pnpm run verify` cannot pass.
- **P1-6 (PROD-009)** No custom scenarios. `POST /math/coach` and `POST /math/equity` are live and
  unreachable from the product; the nav claims the Lab is where you "change one input".

### P2 — significant quality gap

- **P2-1 (PROD-030)** Every page states "you can reset them to the starting amount at any time";
  there is no reset control in the UI. `POST /me/units/reset` works but is not in `API_PATHS`.
  This is both a missing guardrail enforcement point and a false statement in shipped copy.
- **P2-2 (PROD-040)** Nine registered API routes are unreachable from the product, and the
  contract test only checks the direction that cannot detect it.
- **P2-3 (PROD-034)** `PRL_LEGEND_NAMING` — the switch that reveals ten real people's names — is
  undocumented in `.env.example`, which documents every other variable including deliberately
  absent ones.
- **P2-4 (PROD-030)** No sign-out. `POST /auth/logout` is registered and has no client.
- **P2-5 (PROD-027)** No progress is displayed anywhere: `GET /me/progress` has no client.
- **P2-6 (PROD-015)** "Tournament learning" has content and a maths library but no flow — no blind
  levels, no payout ladder, no bubble.

### P3 — polish

- **P3-1 (PROD-021)** The Coach's "size range" collapses to a single number in 20 of the 29 cases
  that carry one, so the type's stated promise is not usually delivered.
- **P3-2 (PROD-023)** `apps/web/src/components/PostHandComparison.tsx:408` labels an axis
  "against the best action the analysis priced" — the one phrase in the shipped UI that a reader
  could read as a correctness claim.
- **P3-3** `SeatView.holeCards` is typed `readonly string[] | null` in
  `packages/contracts/src/api-types.ts:445` but arrives over the socket as numeric card indices
  (observed: `hole [46,47]`). Cosmetic on the wire, but the contract and the payload disagree.
- **P3-4 (PROD-025)** `packages/ui/test/coach-panel-render.test.ts:304` asserts "no percentage the
  panel renders is above 100%" against its own inline fixture, so it cannot catch the 160% in
  `apps/web/src/fixtures/scenarios.ts`.

---

## What I could not test here, and why

- **Browser-side interaction** (clicking through a quiz, driving the live table in a real browser,
  keyboard traversal). Another auditor held the only `next dev` server `apps/web` permits, so I ran
  the pre-existing production build with `next start`. Server renders were verified against my API;
  the browser-side `/api/*` rewrite is baked to `http://localhost:3001` and could not be retargeted,
  though I confirmed the rewrite itself resolves (`GET :3400/api/v1/auth/session -> 200`). The
  client modules are covered by 22 passing `apps/web` unit tests, which I ran, but that is not the
  same as a browser.
- **A second concurrent human at a table.** Not blocked by the environment — blocked by the product
  (PROD-011). There is no way to join.
- **Accessibility** (`pnpm run test:a11y`) — out of my scope; belongs to the frontend reviewer.
