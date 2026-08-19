# Reviewer A — P1 remediations re-check

- **Reviewer:** A (same seat as `agent-a-product.md`). Did not implement the remediations.
- **Date:** 2026-08-19
- **Scope:** ONLY PROD-016, PROD-028 / PROD-038, PROD-037. Not a full product re-audit.
- **Tree:** `HEAD` `f20bbad2f082e9fe135ce98070da16eff7cc3f14` plus uncommitted remediations (working tree; not assumed from `docs/audit/final-traceability.md`).
- **Method:** Source first, then live HTTP. Did not treat lesson/quiz prose as a computed figure.
- **Servers started by this pass (killed afterwards):**
  - API: `PORT=4801 HOST=127.0.0.1 PUBLIC_WEB_ORIGIN=http://localhost:4800,http://127.0.0.1:4800,http://localhost:3000,http://127.0.0.1:3000 COACH_TIMEOUT_MS=15000` → `http://127.0.0.1:4801` (`nodeEnv=development`, 7 route modules).
  - Web: `PRL_API_ORIGIN=http://127.0.0.1:4801 next dev --port 4800 --hostname 127.0.0.1` from `apps/web`.
- **Postgres:** existing `poker-risk-lab-postgres-1` on `127.0.0.1:5432` (healthy). Not taken down.
- **Guest minted:** `usr_ebpxmbwrc3nirq76wwdaizt4gi` (`POST /api/v1/auth/guest` → 201, cookie `prl_session`).

---

## Verdicts

| ID | Original | Re-check | Notes |
| --- | --- | --- | --- |
| PROD-016 | FAIL P1 | **PASS** | Lesson embeds `LiveCalculation` `{ kind: "icm" }`. Quiz `icm-q6` exists and is graded against a live ICM figure. Answer `60` is correct; chip-share `75` is not. Lesson HTML shows the computed 60.0% prize share. |
| PROD-028 | FAIL P1 | **PASS** | Completion still persists. `/learn` now forwards the session and renders this guest’s `read` chip. |
| PROD-038 | FAIL P1 | **PASS** | Same evidence as 028. `completionKnown` follows the cookie, not a constant. |
| PROD-037 | PARTIAL P2 | **PASS** | `ScenarioAttemptResponse.recorded` is on the wire. Anonymous `false`, guest `true`. Lab copy only says “the same one it recorded” when `recorded` is true. |

**Counts for this slice:** PASS 4 · FAIL 0 · PARTIAL 0 · UNVERIFIED 0.

---

## PROD-016 — ICM computed for the learner — **PASS**

### What had to be true

The original fail was not “no ICM prose”. It was: `icmEquity` existed in `@prl/poker-math` and the tournament lesson talked about the curve, but the learner never received a *computed* ICM number (no `LiveCalculation` kind, no numeric quiz field, lesson live calcs were SPR only).

Required for this re-check:

1. Lesson `tournament-chips-and-icm` embeds `LiveCalculation` `{ kind: "icm" }`.
2. Quiz question `icm-q6` exists.
3. Live API grades `icm-q6` against a computed value; submitting `60` must be judged against that computation, not against stored answer-key prose.

### Source

`LiveCalculation` now includes ICM (`packages/contracts/src/content-types.ts`):

```ts
{
  readonly kind: 'icm';
  readonly stacks: readonly number[];
  readonly payouts: readonly number[];
}
```

Lesson `packages/content/data/lessons/decisions.json` (`id: "tournament-chips-and-icm"`) has a `liveCalculation` block:

```json
"calculation": { "kind": "icm", "stacks": [300, 100], "payouts": [70, 30] }
```

plus the two SPR embeds that were already there. The ICM situation is the 3:1 / 70–30 heads-up ladder.

Quiz `packages/content/data/quizzes.json`, question `icm-q6`:

```json
{
  "kind": "numeric",
  "id": "icm-q6",
  "calculation": { "kind": "icm", "stacks": [300, 100], "payouts": [70, 30] },
  "field": "chipLeaderShare",
  "unit": "percent",
  "tolerance": 0.5
}
```

API resolver `icmFields` in `apps/api/src/routes/content.ts` calls `icmEquity(stacks, payouts)` and publishes `chipLeaderShare` as `asPercent(leader / pool)`. The web lesson resolver `resolveIcm` in `apps/web/src/lib/learn-calculations.ts` uses the same function and labels the lead figure “Largest stack’s prize share”.

Independent recompute in this process, from `packages/poker-math/src/icm.ts` (not from the quiz explanation):

```
icmEquity([300, 100], [70, 30]) → equities [60, 40], pool 100 → leader share 60%
```

That is prize equity, not chip share (chip share would be 75%).

### Live API

`GET http://127.0.0.1:4801/api/v1/content/lessons/tournament-chips-and-icm` → **200**. Body includes the lesson, the attached quiz, and glossary. Lesson has **20** blocks. Live calculations in the payload:

| # | kind | situation |
| --- | --- | --- |
| 1 | **icm** | stacks `[300, 100]`, payouts `[70, 30]` |
| 2 | spr | 100bb stack |
| 3 | spr | 12bb stack |

Attached quiz `quiz-tournament-chips-and-icm` has **6** questions. `icm-q6` is numeric, `field: chipLeaderShare`, `calculation.kind: "icm"`, same stacks/payouts, `tolerance: 0.5`. (There is no standalone `GET /content/quizzes/:id`; the quiz is on the lesson payload. The attempt route is still `POST /content/quizzes/:id/attempt`.)

Guest session then grade:

```
POST /api/v1/auth/guest → 201  user usr_ebpxmbwrc3nirq76wwdaizt4gi  Set-Cookie: prl_session=…

POST /api/v1/content/quizzes/quiz-tournament-chips-and-icm/attempt
  { "questionId": "icm-q6", "answer": { "kind": "number", "value": 60 } }
→ 200
  correct: true
  recorded: true
  expected: { value: 60, unit: "percent", tolerance: 0.5 }
```

The explanation is the authored paragraph **plus** the live working from `icmEquity` (“player 0 holds 75.0% of the chips and 60.0% of the prize pool”). That working is not a stored answer key; it is the same derivation the grader used.

Control — same question, chip-share 75 (the trap the original fail described):

```
POST …/attempt  { questionId: "icm-q6", answer: { kind: "number", value: 75 } }
→ 200  correct: false  expected.value: 60
```

So the server is computing prize equity and will not accept chip share.

### Live lesson page (not just JSON)

`GET http://127.0.0.1:4800/learn/tournament-chips-and-icm` → **200**. SSR HTML includes the computed panel, not only the caption:

- Panel title: **Prize equity, not chip share**
- Lead metric: **Largest stack’s prize share → 60.0 %**
- Support metrics: Stack 300 expected prize **60.0**, stack 100 expected prize **40.0**
- Method chip: **closed form**
- Derivation: “player 0 holds 75.0% of the chips and 60.0% of the prize pool”

The caption still *describes* 60/40, but the 60.0 in the metric is produced by `resolveIcm` / `icmEquity` during render. That is the original gap closed.

**PROD-016: PASS.**

---

## PROD-028 / PROD-038 — `/learn` shows this reader’s own progress — **PASS**

### What had to be true

Completion already persisted (`POST /content/lessons/:id/read`). The fail was that `/learn` did not forward a session, hardcoded `completionKnown: false`, and therefore never showed a personal `read` chip. `GET /content/lessons` *with* a cookie could tick `completed`; the page the requirement names would not.

Required:

1. `loadLessonList` forwards `readerCallOptions`.
2. `completionKnown` follows the cookie (API source **and** a session cookie present).
3. Live: mint a guest, mark a lesson read, `GET /learn` HTML shows a **read** chip for that lesson (or the list API ticks `completed` and the page would render it).

### Source

`apps/web/src/lib/learn-data.ts` `loadLessonList`:

```ts
const options = await readerCallOptions();
apiGet<LessonListResponse>(API_PATHS.lessons(), options)
```

`apps/web/src/app/learn/page.tsx`:

```ts
const reader = await readerCallOptions();
const lessons = await loadLessonList();
completionKnown: lessons.source === 'api' && reader.cookie !== undefined,
```

`EntryCard` still uses `entry.completed === true` (not truthiness) for `<Chip glyph="✓">read</Chip>`. `buildCurriculum` only copies `summary.completed` into `entry.completed` when `completionKnown` is true; otherwise it is `null` and no chip is printed.

`apps/web/test/y1-learn-index-honesty.test.ts` now asserts the loader forwards `readerCallOptions` and that `completionKnown: false` is **not** hardcoded. The test still requires the unsigned-out honesty sentence, which is correct: without a cookie the index must not invent unread marks.

### Live

Guest `usr_ebpxmbwrc3nirq76wwdaizt4gi`:

```
POST /api/v1/content/lessons/hand-flow/read  { "completed": true }
→ 200  { lessonId: "hand-flow", completedAt: "2026-08-19T08:15:14.716Z", lastViewedAt: same }
```

```
GET /api/v1/content/lessons   Cookie: prl_session=…
→ 200  17 lessons
  hand-flow.completed === true
  completedIds: ["hand-flow"]
```

```
GET /api/v1/content/lessons   (no cookie)
→ 200  completedCount: 0  hand-flow.completed === false
```

`GET http://127.0.0.1:4800/learn` **with** the guest cookie → **200**:

- Exactly one `✓ read` chip.
- It sits on lesson **01** `/learn/hand-flow` (“How a Hand of Hold'em Runs”), after the “8 minutes” chip.
- Honesty lead (“This index is the same for every reader…”) is **absent**.
- Eyebrow on the suggestion panel is **Start here** (the `completionKnown` branch), not “Where the syllabus starts”.

`GET http://127.0.0.1:4800/learn` **without** a cookie → **200**:

- Zero `✓ read` chips.
- Honesty lead present: “This index is the same for every reader, so it does not know which lessons you have already finished…”

That is the required split: cookie → this reader’s tick; no cookie → unknown, not “everyone unread”.

**PROD-028: PASS. PROD-038: PASS.**

---

## PROD-037 — `ScenarioAttemptResponse.recorded` + Lab copy — **PASS**

### What had to be true

Scoring was already honest. The fail was persistence honesty: anonymous and signed-in POSTs both 200’d with the same keys, the type had no `recorded`, and `ScenarioStage` said “the same one it recorded” for every live 200.

Required:

1. POST attempt **without** a session → `recorded: false`.
2. POST attempt **with** a guest session → `recorded: true`.
3. Lab copy must not claim a write when `recorded` is false.

### Source

`packages/contracts/src/api-types.ts` `ScenarioAttemptResponse` now has required `recorded: boolean`, documented as the same job as `QuizAttemptResponse.recorded`.

`apps/api/src/routes/content.ts` `POST /content/scenarios/:id/attempt`:

- `recorded` starts `false`.
- Set `true` only after `recordScenarioAttempt(...)` returns for a non-null `userId`.
- Reply always includes `recorded`.

`apps/web/src/components/ScenarioStage.tsx` Verdict (user-facing, only occurrence of the old sentence):

```ts
server.state === 'live'
  ? server.recorded
    ? 'This is the server’s own verdict on your action — the same one it recorded.'
    : 'This is the server’s own verdict on your action. Nothing was recorded, because there is no session to attach it to.'
```

No other `apps/web` Lab string still claims a recording on a live anonymous verdict. Fixture attempts set `recorded: false` (`apps/web/src/fixtures/scenarios.ts`).

### Live

Scenario `eq-flush-draw-turn-small-bet`, body `{ "action": "fold" }` (legal, not the analysis line — scoring is not the question):

| Caller | Status | `recorded` | Other keys |
| --- | --- | --- | --- |
| CSRF only, no `prl_session` | 200 | **false** | `analysis`, `commonMistakes`, `consistentWithAnalysis`, `reasoning`, `recorded` |
| Guest `usr_ebpxmbwrc3nirq76wwdaizt4gi` | 200 | **true** | same key set |

Both replies include `recorded` as a boolean. Anonymous 200 is no longer indistinguishable from a write.

The Lab panel cannot print “the same one it recorded” for the anonymous reply: that string is behind `server.recorded === true`. When `recorded` is false it prints the “Nothing was recorded…” sentence.

**PROD-037: PASS.**

---

## What this pass did not re-open

Not in scope: PROD-025 fixtures, PROD-040 `formatPercent`, PROD-041/048 Learn minting no guest, Coach/ICM in Scenario Lab (`rk-when-survival-outweighs-chip-ev` still teaches chip-EV-only for that spot). Those were not this P1 list.

`GET /content/quizzes/quiz-tournament-chips-and-icm` is 404; that is not a regression against the original fail. The quiz is delivered on the lesson GET and graded on the attempt POST.

---

## Runtime handle

- API listen: `http://127.0.0.1:4801` (`health` 200 `{ status: "ok", version: "0.1.0", protocolVersion: 1 }`).
- Web listen: `http://127.0.0.1:4800` (Next 16.3.0).
- Guest used for 016/028/038/037: `usr_ebpxmbwrc3nirq76wwdaizt4gi`.
- Lesson marked read: `hand-flow` at `2026-08-19T08:15:14.716Z`.
- Servers started by this reviewer were stopped after evidence was captured. Compose Postgres was left running.
