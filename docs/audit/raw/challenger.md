# Challenger report — Poker Risk Lab pre-release audit

**Role:** final independent challenger. Mandate: assume the team wants to ship too early; try to
prove the product does **not** meet its goal; find requirements claimed complete without evidence.

**Information wall:** I did not read, list, grep or open anything under `docs/audit/**` or
`docs/reviews/**` before writing this file. The only path I touched in those trees is this file.
`docs/REPORT.md` §8 references `reviews/release-findings.md` and `reviews/final-release-report.md`
by name; I did not open them. Everything below is my own measurement.

**Environment:** api on `127.0.0.1:3601` (my own instance, `PUBLIC_WEB_ORIGIN=http://localhost:3600`),
web on `localhost:3600` (a shadow Next project in my scratch dir pointing at 3601, because a
pre-existing `next dev` on :3200 holds the repo's dev-instance lock). Where I could only get a
render out of the pre-existing :3200 server I say so explicitly. Postgres: the already-running
`poker-risk-lab-postgres-1`. I created guest sessions, rooms and hands (ordinary app usage). I did
not run `pnpm install`, `db:reset`, or `docker compose down`, and I changed no source, test or
config file.

---

## Verdict

**FAIL — do not ship.**

The declared release gate is red, and behind it sits a live, user-visible correctness defect of
exactly the kind this product exists to avoid: the Coach recommends an action the learner cannot
take, prices it with an assumption that cannot hold, and then grades the learner *wrong* for
choosing the action the lesson is teaching.

| Gate | Command | Real exit code |
|---|---|---|
| Full test suite | `pnpm run test` | **1** — 534 tests, **2 deterministic failures** (see the correction note below) |
| Release gate | `pnpm run verify` | **1** — same failures, after a clean `build` |
| Supply chain | `pnpm run security:audit` | 0 — 8/8 gates pass |
| Accessibility | `node scripts/a11y-audit.mjs --base-url http://localhost:3200` | 0 — 6 routes, 0 violations (see CHAL-009) |
| ws-socket file alone | `node --test test/ws-socket.test.ts` | 0 — 8/8 pass (see CHAL-008) |

Counts: **12 findings** — 4 × P0, 3 × P1, 4 × P2, 1 × P3.

> **Correction, made after cross-checking against the other reviewers and re-measuring.** My first
> two full-suite runs both reported `fail 3`. Four other reviewers reported `fail 2`. I re-ran
> `pnpm run test:integration` with my own API and web servers stopped: **`tests 534 · pass 532 ·
> fail 2 · EXIT=1`** — matching them. The two deterministic failures are both fixture-figure tests
> (CHAL-003). The third, `ws-socket.test.ts:851`, appeared in 2 of my 3 runs and in 0 of Reviewer
> H's 4 runs; it is load-sensitive rather than order-dependent, and I have re-graded it P2 and
> re-diagnosed it below (CHAL-008). **The headline is unchanged: `verify` exits 1 either way**, and
> it exits 1 for a reason no amount of re-running will fix.

---

## Findings

### CHAL-001 — P0 — The Scenario Lab Coach recommends actions the learner cannot legally take, priced with impossible assumptions

**7 of the 36 live scenarios** publish a `bet`/`raise` candidate that hero cannot make. In **all
seven**, `suggestion.action === "raise"` — the impossible action is the Coach's headline
recommendation, at stated confidence `reasonable` or `moderate`.

Two independent root causes, both proven:

**(a) `legalActions` is never passed on the content path.** `CoachInput.legalActions` is optional,
and `packages/poker-math/src/coach.ts:556` reads:

```ts
const permitted = (action: CoachAction): boolean =>
  input.legalActions === undefined || input.legalActions.includes(action);
```

`apps/api/src/ws/router.ts:653,685` passes it (live table — correctly guarded). The Scenario Lab
path does not: `CoachTask` in `apps/api/src/workers/equity-worker.ts:105-120` has **no
`legalActions` field at all**, and `coachTaskFor` in `apps/api/src/routes/content.ts:315-342` does
not set even `minimumRaiseTo`. So for every scenario, every action is treated as legal.

**(b) `heroStack` units mismatch.** `buildCandidates` computes `maxTo = heroCommittedThisStreet +
heroStack` and `maxRaiseBy = heroStack - toCall`, which is correct only when `heroStack` is *chips
behind* (as it is on the live path, where it comes from `SeatView.stack`). `readSituation` passes
`hero.stack` — the seat's **total stack for the hand** — so `maxTo` double-counts whatever hero has
already committed this street. The overshoot equals `heroCommittedThisStreet` exactly, in all five
cases:

| Scenario | hero stack | committed this street | Coach's all-in `to` | overshoot |
|---|---|---|---|---|
| `fl-big-blind-option-limped-pot` | 990 | 10 | 1000 | +10 |
| `fl-heads-up-blind-reversal` | 995 | 5 | 1000 | +5 |
| `rk-high-spr-same-top-pair` | 1400 | 55 | 1455 | +55 |
| `rk-nine-big-blinds-call-or-fold` | 10000 | 800 | 10800 | +800 |
| `rk-when-survival-outweighs-chip-ev` | 24000 | 2000 | 26000 | +2000 |

And four scenarios price a raise with 35 % fold equity against an opponent who is **already
all-in and cannot fold**: `eq-rule-of-four-big-draw-flop`, `eq-set-on-connected-flop-jam`,
`rk-nine-big-blinds-call-or-fold`, `rk-when-survival-outweighs-chip-ev`.

**Cleanest single case — `eq-set-on-connected-flop-jam`.** Heads-up. BTN stack 150, committed 150
(all-in, nothing behind). The question is literally *"Should hero call the all-in or fold?"* The
same panel says, in `stackContext.explanation`:

> "The deepest opponent has only 150, so at most 150 can change hands even though you have 320.
> **The 170 above that is not in play this hand — nobody can pay you for it and nobody can take it.**"

…and then, a few blocks down, in the raise candidate's derivation:

> "EV(raise) = f × pot + (1 − f) × [ … ] = **0.35 × 240** + 0.65 × [ 0.7101 × (240 + 150 + 2 × 170) −
> 320 ] = 84 + 128.94 = **212.94** chips. **Raising by 170** puts your whole remaining stack in.
> **A caller needs 23.3 % equity** to break even on the extra 170…"

…and the suggestion:

> **raise**, confidence *reasonable*, "raise has the highest expected value against the stated
> range, **by 86.0 chips** over the next-best action."

There is no caller. The 84-chip fold-equity term is against a player who is all-in. The true best
line is `call` at EV 126.94. The 86.0-chip edge is entirely fabricated, and it points at aggression.

The engine gets this right when hero's remaining stack happens to equal the call exactly
(`rk-an-all-in-that-is-nearly-even` correctly emits no raise and suggests `call`), which is why the
defect looks intermittent.

**Repro:**
```
curl -s http://127.0.0.1:3601/api/v1/content/scenarios/eq-set-on-connected-flop-jam | \
  python3 -c "import sys,json;d=json.load(sys.stdin);print(d['analysis']['suggestion']);\
[print(c['action'],c.get('to'),c.get('cost'),c['ev']) for c in d['analysis']['candidates']]"
```

The interactive control has the same hole independently of the Coach. On
`/lab/eq-set-on-connected-flop-jam` (rendered, :3200) the decision widget offers "How much to raise
to … ⅓ pot — 300 units total … All in — 320 units total", "Raise size slider … **Allowed range 300
to 320 units**", and a **"Raise to 300"** button — against an all-in opponent, on a page whose own
stated assumption #02 reads *"Calling puts the opponent all in, so both remaining cards are dealt
and **no more units can go in**."* `apps/web/src/lib/scenario-view.ts` derives the bounds from the
scenario rather than from the engine and its header says the job is "to make the illegal amount
unreachable in the sizer"; it does not encode the "no raise when every live opponent is all-in"
rule.

---

### CHAL-002 — P0 — The scenario grader marks the lesson's own answer wrong, against the fabricated number

`rk-when-survival-outweighs-chip-ev` is titled **"A profitable call worth declining"**. Its
`reasoning` teaches that folding can be right. Hero: BB, stack 24 000, 2 000 committed, facing an
SB shove of 24 000 — "*which is exactly what hero has. Calling puts hero all in.*"

`POST /api/v1/content/scenarios/rk-when-survival-outweighs-chip-ev/attempt`:

| Learner's choice | Server's answer |
|---|---|
| `{"action":"fold"}` | `consistentWithAnalysis: false` — "fold is not consistent with this analysis … it comes out about **11 873.7 chips behind**" |
| `{"action":"call"}` | `consistentWithAnalysis: true` |
| `{"action":"raise","to":26000}` | `consistentWithAnalysis: **true**` — "**You sized it to 26000; the analysis priced 26000.**" |

Three things are wrong at once:

1. The 11 873.7-chip deficit the learner is measured against is the EV of the **impossible** raise
   (26 000 from a 24 000 stack, with 9 100 of it coming from 35 % fold equity against an all-in
   player). The learner who follows the lesson is told, with a number, that they are wrong.
2. The endpoint **accepts and validates a raise size larger than hero's entire stack**, writes it
   to `scenario_attempts`, and confirms it back as consistent. `scenarioAttemptBodySchema` bounds
   `to` only by `0 … 1 000 000`; nothing checks it against the stack.
3. `eq-set-on-connected-flop-jam` behaves identically: `fold` → "about **212.9 chips** behind".

This breaches the guardrail "**never teach something false**" (PRODUCT-GUARDRAILS §4) directly.

**Repro:** see `scratchpad/challenger/attempt.mjs`; guest session → CSRF → POST the bodies above.

---

### CHAL-003 — P0 — The shipped web fixtures render provably wrong teaching figures to learners

`apps/web/src/fixtures/scenarios.ts` and `apps/web/src/fixtures/review.ts` are generated
`CoachReport`s frozen as literals. They were generated **before** the rule-of-2-and-4 corrections
landed in `@prl/poker-math` and were never regenerated. Two of the three failing tests
(CHAL-004) are the repo's own detector firing on exactly this.

Wrong figures, checked by hand:

| Where | What the learner is shown | Correct value | Error |
|---|---|---|---|
| `review.ts:437-452` (`REVIEW_HAND_SHOWDOWN`) | "*Notice the split: **8 clean and 7 dirty**…*" then "*The rule of 2 and 4 gives **60 %** here, overstating the real figure by 16.7 points*", `estimate: 0.6` | rule applies to **clean outs only** (its own adjacent sentence says so): 8 × 4 = **32 %** vs exact 1 − (39/47)(38/46) = **31.5 %**, overstating by **0.5** points | **28 points**, and a self-contradiction inside one panel |
| `review.ts:606-621` | "*the rule of 2 and 4 gives 24 % here, **understating the real figure by 8.1 points***", `errorPoints: -8.139` | 12 clean outs, one card, 46 unseen → 12/46 = **26.1 %**; the shortcut understates by **2.1** points | 6-point error; it compares the shortcut against hero's **equity**, which `coach.ts` explicitly calls a bug |
| `scenarios.ts:499 / 618` (`flop-flush-draw-price`) | "*gives 36 % here, **understating** the real figure by 2.4 points*" | 9 clean outs, two cards, 47 unseen → **35.0 %**; the shortcut **overstates** by 1.0 | **direction of the error is reversed** |
| `scenarios.ts:959-961` | "*40 outs with two cards to come, times 4, is roughly **160 %** — the rule of 2 and 4*", `estimate: 1.6`, "*overstating by 95.5 points*" | not a probability; hero is already ahead (64.5 % equity) and 38 of the 40 "outs" are dirty | a **160 % probability** on an authoritative-looking panel |

The library now has three separate guards against the last row — `ruleOf24` throws above the
ceiling, `ruleOfThumbRefusalFor` returns `already-ahead` / `not-a-probability`, and
`assertProbabilityFraction` refuses anything outside 0..1. **A frozen literal bypasses all three.**

**Reachability is not hypothetical, and it is wider than "the API is down".** Other reviewers scope
fixture exposure to `isApiUnavailable` (transport error or 5xx). That is right for `/lab`. It is
**not** the only door. `apps/web/src/app/review/page.tsx` carries a second, distinct fixture branch
keyed on `fromFixture === 'signed-out'`, whose own rendered copy reads *"Hand history is private to
one reader, and **you are not signed in** — so there is no history to read and the rows below come
from `src/fixtures/review.ts`."* I confirmed that branch renders for an anonymous request with the
API fully healthy, and that its six rows link to `/review/hand-0037…0042`. Opening one then serves
the full fixture review with HTTP 200. Verified against the running app:

```
$ curl -s http://127.0.0.1:3200/review/hand-0042 | grep -c 'rule of 2 and 4 gives 60'
1
$ curl -s http://127.0.0.1:3200/review/hand-0042 | grep -c 'Notice the split: 8 clean and 7 dirty'
1
```

Both strings are in the delivered HTML of the same decision's teaching notes. The Scenario Lab
fixture is narrower — it needs the API to be unreachable — but when it fires the learner also gets a
**different, six-scenario corpus** whose ids do not exist server-side, in place of the 36 the API
ships.

The fixture pages' own disclosure is false in the direction that matters. `/lab` says *"Every figure
in it **was computed by the real analysis functions**"*; `/review/[handId]` says *"That fixture **was
generated by running the real `buildHandReview`**"*. Both were, by an older version that the repo's
own test now says is wrong.

---

### CHAL-004 — P0 — The declared release gate is red, and the release documents do not say so

```
$ pnpm run test:integration   → exit 1   tests 534 · pass 532 · fail 2   (clean machine, re-measured)
$ pnpm run verify             → exit 1   (after security:audit, hygiene, lint, build, typecheck and
                                          design:contrast all passed — not a stale-dist artefact:
                                          the log shows all seven `tsc` builds and `next build`
                                          completing at lines 96-130, before `test` at line 474)
```

The two deterministic failures — plus one intermittent:

1. `apps/api/test/web-fixture-figures.test.ts:100` — *"the Scenario Lab fixture is the analysis the
   engine produces today"* → `flop-flush-draw-price`'s stored analysis is not what the engine
   computes now.
2. `apps/api/test/web-fixture-figures.test.ts:230` — *"`REVIEW_HAND_SHOWDOWN` replays and analyses
   identically"* → same class.
3. *(intermittent, 2 of my 3 runs, 0 of Reviewer H's 4)* `apps/api/test/ws-socket.test.ts:851` —
   *"sits, plays to completion against a bot"* → `no stack changed across the hand: [1000,1000]`.
   See CHAL-008.

**A second, quieter consequence:** `verify` is a `&&` chain and `db:verify` is its **last** step, so
while `test` fails, `pnpm run db:verify` — the gate REPORT.md §4 describes as "asserts the **LIVE**
schema's security properties" — **never executes**. I confirmed this against the run log: it
contains `security:audit`, `security:hygiene`, `biome check` (348 files), the seven `tsc` builds, the
typechecks, `design:contrast` and the test run, and nothing after it. Every claim about
least-privilege database roles that rests on `verify` is therefore currently unexercised in the one
command the documents tell you to run.

`docs/REPORT.md` §4 "Verification" lists `pnpm run verify` first and `docs/VERIFICATION.md` §13
closes with *"Or in one command: `pnpm run verify`"*. Neither document, and neither §6 "Known
limitations" nor §12 "What is NOT verified — the honest section", discloses that the suite is
currently failing. A reader following either document's instructions gets exit 1. **Overclaimed
disclosure is itself the finding**: the honest-limitations sections are detailed and credible
everywhere except on the one fact that blocks release.

(Minor, same family: REPORT.md §4 describes `verify` as "security:audit → hygiene → lint → build →
typecheck → test"; the script also runs `design:contrast` and `db:verify`.)

---

### CHAL-005 — P1 — Tournament Learning (ICM) has no product surface at all

Required mode. `packages/poker-math/src/icm.ts` implements Malmuth–Harville with a 9-player cap,
`icmVsChipEv`, assumptions and explanations, and `packages/poker-math/test/icm.test.ts` exercises it
thoroughly. A repo-wide search for every exported ICM symbol
(`icmEquity|icmVsChipEv|MAX_ICM_PLAYERS|IcmResult`), excluding `dist/`, `node_modules/` and the
walled doc trees, returns **only** its own unit test and the package's own barrel re-export.

- `apps/api/src` — **0** occurrences of `icm` (case-insensitive).
- `packages/contracts/src` — **0**. No wire type, no endpoint, no schema.
- `apps/web/src` — 8 occurrences, all prose: glossary entries, lesson text, a topic label, a nav
  string. Nothing computes anything.
- `apps/web/src/lib/nav.ts` ships **five** destinations: Learn, Play, Lab, Legends, Review. There is
  no tournament route among the 13 that `docs/REPORT.md` §1 enumerates.

`docs/VERIFICATION.md` §12 lists "ICM accuracy" as a caveat about the *model*, which reads as
though the feature exists. The two tournament scenarios in the Lab
(`rk-nine-big-blinds-call-or-fold`, `rk-when-survival-outweighs-chip-ev`) are analysed in **pure chip
EV**; I confirmed `analysis.assumptions` for the latter contains no ICM term, and the scenario's own
assumption #02 concedes *"Every figure the app computes here is chip expected value. It does not
model the value of a finishing position, so it answers only half of the question this spot asks."*

`docs/REPORT.md` contains **zero** occurrences of the word "tournament". The delivery report does not
overclaim this mode — it omits it entirely, which is worse for a reader checking delivery against
the contract: nothing in the report signals that a required mode is missing, and §1's route list
reads as a complete inventory.

A library nothing calls is not a product mode. **This requirement is not delivered.**

---

### CHAL-006 — P1 — "Play-money tables (private, invite-only)" is unreachable: the invite code is generated and thrown away

The API implements it properly. `POST /api/v1/rooms` returns `visibility: "invite_only"` and an
invite code — I received `V42V-B9VJ-4FJ9-4GT7` from my own run — and `POST /rooms/join` accepts one.

The web client does not expose any of it:

- `grep -rn "inviteCode" apps/web/src` → **no matches**. `createBotRoom` calls `POST /rooms`,
  receives `CreateRoomResponse.inviteCode`, and discards it. The owner is never shown the code.
- There is no `/rooms/join` call anywhere in the client, and no `roomJoin` entry in
  `API_PATHS`/`API_PATH_PROBES` — so by the client's own stated rule ("There is no supported way to
  build a request path outside this table"), joining a room by invite is not constructible.
- `GET /rooms/:roomId` and `POST /legends/matches` are likewise absent from the shared path table.
  *(Correction: I originally also listed `/rooms/:roomId/sit` and `/rooms/:roomId/leave`. Those are
  absent **by design** — `api-paths.ts:106` states "Sitting and leaving are deliberately NOT here:
  they happen over the socket, where they are ordered against the hand the seat is in". I withdraw
  those two.)*
- `/play` offers exactly one thing: "Six-handed table — A private table against five bots." No
  invite affordance, no code entry field, no room list.

`apps/web/src/lib/table-rooms.ts:118` asserts *"it is what makes 'private, invite-only' **true**
rather than a label"*. It is a label: no learner can invite anyone, and no learner can join anyone.
**Multiplayer play-money tables are shipped as server code with no user-facing entry point.**

**Pre-empting the disagreement this will meet.** A security reviewer graded private multiplayer
PASS, having exercised it server-side (room is invite-only, wrong code rejected, uninvited caller
gets 404 not 403). That is correct and it does not conflict with this finding — the boundary is
drawn exactly right in the consolidated security write-up: *"This proves the **server** supports
private multiplayer. It does **not** mean a user can reach it."* Both statements are true; only one
of them is a product requirement.

The nav strapline compounds this: "Play — Tables against bots, **AI Legends and private rooms**".
Only the bot table exists on that page.

---

### CHAL-007 — P1 — `coach-legality.test.ts` is a gate that cannot fail for the code path it was written for

This is the highest-value structural finding. The test's own header states the bug it exists to
prevent, in the present tense, as fixed:

> "no bet or raise when every live opponent is all-in, because nobody could call it … Measured before
> the fix, in a three-handed preflop spot with one seat folded and the other all-in: the engine
> offered `fold, call`, **the Coach published three raises, and its headline suggestion was "raise to
> 80-100" at "reasonable confidence"**."

That is a verbatim description of what `/api/v1/content/scenarios/eq-set-on-connected-flop-jam`
still returns today (CHAL-001). The test passes because **the test supplies `legalActions` itself**:
it reconstructs a `HandState` from the scenario JSON, calls the engine's `legalActions`, and hands
the result to `buildCoachReport`. The shipped endpoint does not — `CoachTask` has no such field —
so the guard the test exercises is not in the request path. The test proves the Coach *can* respect
legality when told; it cannot detect that the product never tells it.

Same shape, smaller stakes, in `apps/api/test/web-api-paths.test.ts` ("every path the web client can
emit is a registered route"): it iterates `API_PATH_PROBES`, so it proves no path the client emits
404s. It is structurally incapable of noticing the five server routes the client was never taught
about (CHAL-006) — which is the failure that actually shipped.

---

### CHAL-008 — P2 — A release-gate test's outcome depends on machine load *(re-diagnosed and downgraded)*

**I originally called this order-dependent and graded it P1. That was wrong, and the correction is
worth more than the original claim.**

Measurements, mine and others':

| Run | Conditions | `ws-socket.test.ts:851` |
|---|---|---|
| my `pnpm run test` | 4 other agents' API servers live on the same Postgres; heavy CPU contention | **FAIL** |
| my `pnpm run verify` | same, plus a full `build` in the same process tree | **FAIL** |
| my `ws-socket.test.ts` alone | quiet | PASS (8/8) |
| my `pnpm run test:integration` re-run | **my own servers stopped** | **PASS** (534 / 532 / **2**) |
| Reviewer H × 4 full runs | — | PASS every time ("no nondeterminism observed in ~5,000 test executions") |

So it is not the suite's ordering; it is **contention**. That also explains the shape of the
failure, which had puzzled me: every earlier assertion in the test passes — `street === 'complete'`,
`result !== null`, `netBySeat` sums to 0, `awarded > 0` — and only `stacks.some(s => s !== 1000)`
fails. A completed hand that awarded a pot cannot leave both seats on their starting stack, so the
frame the assertion reads is almost certainly **not the terminal frame of the hand it just played**:
under load the table's next hand is dealt before the client reads the last `state`, and the seats
come back at their fresh starting stacks. That is a race between hand settlement and the next deal,
and the test happens to be where it surfaces.

Severity: **P2**, not P1. The mode itself works — I drove a 6-max bot table and a heads-up bot table
end to end over a real socket and both dealt, played, showed down and settled with chips conserved
and a per-card Merkle reveal attached. But a release-gate test whose verdict depends on what else is
running on the machine is still a defect in the gate: it makes `verify` un-greenable for a reason
unrelated to the two real failures beside it, and it is exactly the kind of noise that trains a team
to re-run until green. **Reviewer H's clean four-for-four is not evidence that it is fine — it is
evidence that H's machine was quiet.**

---

### CHAL-009 — P2 — The shipped a11y gate cannot evidence WCAG 2.2 AA, and is not in `verify`

*Scoped precisely, because a colleague's browser run reaches a different number and I do not want
this refuted on a technicality.* This finding is about **the gate as `pnpm run test:a11y` invokes
it**, not about whether the app is accessible.

`node scripts/a11y-audit.mjs --base-url http://localhost:3200 --no-start` → exit 0, **6 routes**, 0
violations. Six, because `scripts/a11y-audit.mjs:154-157` defaults to `routes: ['/']`,
`crawlDepth: 1`, `maxRoutes: 12` — a depth-1 crawl from `/` reaches only the five nav destinations.
What it covered:

- **Routes:** `/`, `/learn`, `/lab`, `/legends`, `/review`, `/play`. Nothing else. So
  `/learn/[lessonId]`, `/learn/glossary`, `/lab/[scenarioId]`, `/review/[handId]`,
  `/legends/[profileId]`, `/legends/compare` are **not audited by the default invocation** — i.e.
  every interactive surface in the product: the raise slider and preset buttons, the quiz runner,
  the hand-replay timeline, the coach panel disclosures, the commitment verifier.
  *(A reviewer who passes `--crawl-depth 2 --max-routes 40` reaches 40 routes with 0 violations.
  Good — but that is not what the release command runs, and the flags are not in any documented
  command.)*
- **Depth:** the tool's own banner — "*STATIC audit of server-rendered HTML. No browser, so no
  colour contrast, no focus order, and nothing that CSS or client-side JavaScript decides*" — and
  its own footer — "*This is not a statement that the app is accessible*".
- **Placement:** `test:a11y` is **not in `pnpm run verify`**. `verify` runs `design:contrast`, which
  is a static token check, not a rendered-page check.

No *repository gate* exercises WCAG 2.2's new criteria (2.4.11 Focus Not Obscured, 2.4.13 Focus
Appearance, 2.5.7 Dragging Movements — directly relevant to the raise **slider** — or 2.5.8 Target
Size). `docs/VERIFICATION.md` §12 is honest that the audit is static; the product contract says
accessibility is a **functional requirement**, and a functional requirement whose only automated
check runs on six pages of static markup and is excluded from the release gate is not evidenced *by
the build*.

**Not a claim that the app is inaccessible.** A reviewer working in real Chrome with a
self-validating harness graded 24 PASS / 7 PARTIAL / 0 FAIL across 31 UX+A11Y requirements,
including SC 2.4.11 and 2.5.8 as PASS, and found one genuine AA failure (SC 4.1.3: the `/play`
table-error `DIV.prl-error` has no `role="alert"` and no live-region ancestor while the page's only
`role="status"` simultaneously announces "Ready to connect."). That evidence is far stronger than
anything the repo's own tooling can produce — which is precisely this finding: **the release gate
cannot see what a browser run sees, and the browser run is not in the release gate.**

---

### CHAL-010 — P2 — The app tells every learner, on every page, something that is false

The site footer, rendered on all routes I fetched:

> "**Every** equity, out, price and expected value is computed from the actual deck when you ask for
> it. **There is no stored odds table anywhere in this product, so there is no table that can be
> quietly wrong.**"

There are four: `apps/web/src/fixtures/scenarios.ts` (113 hard-coded percentage literals),
`review.ts` (81), `legends.ts` (60), `table.ts` (14). Two of them **are** quietly wrong right now
(CHAL-003), and `/review` serves one of them to every signed-out visitor by default.

Credit where due: the *server* content corpus is clean. `grep -ohE '[0-9]+(\.[0-9]+)?%'` over
`packages/content/data/lessons/*.json`, `quizzes.json` and `glossary.json` returns **zero** matches,
and the Learn fixtures contain zero percentage literals — lesson numbers are computed at runtime by
`apps/web/src/lib/learn-calculations.ts`. ADR 0006 holds everywhere except the client fallback, and
the footer sentence should be scoped to match.

---

### CHAL-011 — P2 — `pnpm run test` is not hermetic; the workspace `dist/` is load-bearing and gitignored

`dist/` is in `.gitignore`, every `@prl/*` package resolves its `.` export to `dist/`, and
`pnpm run test` does **not** build first (only `verify` does, and it puts `build` before `test` for
this reason, documented in REPORT.md §4). A contributor who edits `packages/poker-math/src` and runs
the documented `pnpm run test` is testing the previous build. The API dev server
(`node --watch src/server.ts`) has the same exposure: it serves whatever is in `dist/`.

This did not cause the two deterministic failures above — they survive a clean build inside `verify` — but it is
why "the tests pass on my machine" and "the tests pass" are not the same statement here.

---

### CHAL-012 — P3 — Small factual drift in the release documents

- REPORT.md §8: "It changed **6 of 35** shipped scenario recommendations". The API serves **36**
  scenarios; VERIFICATION.md §9 also says 36.
- REPORT.md §5: "`Math.random` is banned across all **8** source trees"; the scan's own comment and
  `scripts/supply-chain/repo-hygiene.mjs` say **seven**.
- REPORT.md §4 omits `design:contrast` and `db:verify` from its description of `verify`.

---

## What I verified as genuinely working (with the evidence)

These are PASSes I produced at runtime, not file-existence checks.

| Requirement | Evidence |
|---|---|
| **Guided Practice vs bots** | Drove a real socket end to end twice: 6-max (5 bots) and heads-up (1 bot). Both dealt, bots acted, streets advanced, showdown resolved, pot awarded, `netBySeat` summed to 0, terminal `street: "complete"`. Chips conserved. |
| **Hand Review — replay** | `GET /api/v1/hands` then `/hands/:id` on a hand I had just played: 12 decisions, per-street, per-seat, with per-decision `analysis` attached only to my own seat. |
| **Hand Review — deck-commitment verification in the browser** | Loaded `/review/hand-0042` in Chrome. The page shows **"PROVED IN YOUR BROWSER — 9 of 52 deck positions"**, "✓ proof holds", the Merkle root, and separately "THE SERVER SAID verified, 9 positions". The client-side `verifyDeckReveal` genuinely runs and is reported independently of the server's verdict — this requirement is met, and met in the right spirit. (It works under Turbopack; under `next dev --webpack` the `node:crypto` import fails to resolve and the whole route 500s. The code comment claiming webpack's `crypto-browserify` shim covers it is describing the un-prefixed specifier, not `node:crypto`. Not a release blocker, but the comment is wrong.) |
| **Per-card Merkle commitment** | Live hand returned `reveal.commitment` (`sha256`, `prl-deck-v2`, root, context bound to `room:handNumber:handId`) with 9 leaves, each with a 32-byte salt and a 6-hash proof path. Only dealt/shown cards revealed; 43 positions stay sealed. |
| **Coach contract, on the live-table path** | A `requestCoach` report over the socket carried: method labelled `monte-carlo` with `trials`, a 95 % CI (`±1.58 points`) in both `equity` and `uncertainty`, pot odds + break-even equity with the arithmetic (`20 / (30 + 20) = 40.0%`), an EV line per action with its formula spelled out, a suggestion with confidence / reason / `whatWouldChangeIt`, and a full `assumptions` list. Rendered, the panel is headed "ONE READING OF THIS SPOT" and closes with "*A suggestion that follows from the assumptions listed below — not a claim about the best play.*" |
| **Never claims correct/optimal** | Scanned every page I rendered for "correct", "optimal", "you should", "best play", "guaranteed": the only hits are the footer's own negations ("no figure is presented as the one correct play"). Holds. |
| **Guardrail language** | Same scan for "real money", "cash out", "deposit", "purchase", "jackpot", "bonus", "crypto", "streak": every hit is inside a negation in the footer or the units explainer. No dark-pattern language found. |
| **Learn — lessons, quizzes, glossary** | 17 lessons from the live API; `/learn` renders from the API with no fixture note. Answered a multiple-choice question and a numeric one through `POST /content/quizzes/:id/attempt`: both graded `correct: true`, the numeric one against a runtime-computed `expected: {value: 3, unit: "ratio", tolerance: 0.2}` with the derivation returned in prose. `/me/progress` then reported `quizQuestionsAnswered: 2` with no score or streak. **⚠ Downgrade this to a PASS of the API, not of the mode** — see the correction directly below. |

> **Correction to the Learn PASS.** My evidence was API-level. Prompted by another reviewer's
> finding, I checked the UI myself and confirmed it: **`API_PATHS.quizAttempt` has zero call sites
> in `apps/web/src`** (`grep -rn "quizAttempt" apps/web/src` returns nothing outside fixtures), and
> `QuizRunner.tsx:97,112` grades client-side against the `question.correctIndex` shipped in the
> payload. So the endpoint I exercised is **unreachable from the product**, and a real learner's
> quiz answers are never recorded — `quizQuestionsAnswered` only moved because *I* called the API
> directly. Learn is therefore PARTIAL, not PASS.
>
> One thing that is genuinely fine here, and worth saying so the fix does not overshoot: numeric
> questions carry `calculation: LiveCalculation` and **no stored expected value**
> (`packages/contracts/src/content-types.ts:171-179`), so the client recomputes them at runtime
> through `learn-calculations.ts`. ADR 0006 holds on this path even client-side. The defect is the
> missing submission, not a hard-coded answer.
| **Supply chain** | `pnpm run security:audit` → exit 0. 8/8 gates: policy, encoding hygiene, denylist, dep shapes, Shai-Hulud IOC sweep (10 501 files), integrity + release age (162 versions), OSV (0 advisories), SBOM (170 components). This gate is real and it passes. |
| **`Math.random` ban** | Genuinely well-built: repo-wide scan in `repo-hygiene.mjs` over all source trees, plus package-local recursive scans, each with a negative-control test that feeds the detector a violation and a prose mention and asserts it distinguishes them. This is the shape every other gate here should have. |
| **No hard-coded numbers in server content** | Zero percentage literals across `packages/content/data/**`. |

## Marked UNVERIFIED (I could not produce runtime evidence within this audit)

- `pnpm run test:exhaustive` (133 784 560 seven-card hands) — claimed ✔ in VERIFICATION.md §2.2, but
  it is in neither `test` nor `verify`; I did not run it.
- `pnpm run test:simulation`, `test:load`, `test:smoke` — not run.
- Redaction/hidden-information guarantees — the suite's own tests pass and the frames I captured
  never carried another seat's cards, but I did not construct an adversarial case.
- Everything in `docs/THREAT-MODEL.md` and `docs/SECURITY.md` beyond the headers I observed on
  `/healthz` (CSP, COEP/COOP/CORP, HSTS-adjacent set, `x-request-id`, rate-limit headers — all
  present) and the CSRF/Origin refusals the suite exercises.
- WCAG 2.2 AA — see CHAL-009.

---

## Direct answer to the question I was set

> **Is there any requirement being claimed as complete that does not have sufficient evidence?**

**Yes — four, and one of them is claimed complete while a test in this repository is actively
saying it is not.**

1. **"The Coach must never claim an action is correct, and must never teach something false."**
   Claimed complete; `docs/VERIFICATION.md` §9 offers 74 scenario claims as "genuine independent
   verification". Every one of those claims is qualitative (`equityExceedsBreakEven`,
   `callEvSign`) and none of them says anything about the Coach's candidate list. So 7 of 36
   scenarios recommend an action the learner cannot take, and the grader tells a learner who follows
   the lesson that they are 11 873.7 chips behind — while the scenario's own claims pass.
   (CHAL-001, CHAL-002)

2. **"Every number the learner sees is computed at runtime; no hard-coded computed numbers."**
   Claimed complete and enforced by ADR 0006. True of the server corpus, false of the four client
   fixtures — and `apps/api/test/web-fixture-figures.test.ts` **currently fails** saying so. The
   evidence against the claim is already in the repository; it just isn't in the report.
   (CHAL-003, CHAL-010)

3. **"Tournament Learning (ICM)" as a product mode.** There is a well-tested ICM library and no
   caller anywhere in the API, the contracts, or the web app. `docs/REPORT.md` §1 lists 13 web
   routes and none of them is a tournament surface; the omission is silent rather than disclosed.
   A library with no call sites is not evidence of a mode. (CHAL-005)

4. **"Play-money tables — private, invite-only."** The server-side is correct and complete; the
   invite code is generated, returned once, and discarded by the only client that asks for it, and
   no join path exists in the shared path table. The claim in
   `apps/web/src/lib/table-rooms.ts` that this "makes 'private, invite-only' true rather than a
   label" is exactly backwards. (CHAL-006)

And the meta-answer, which matters more than any single item: **the strongest evidence in this
repository is currently pointing at the product and being ignored.** `pnpm run verify` exits 1.
`coach-legality.test.ts` describes, in its own header, the precise defect that is still live on the
shipped endpoint — and passes, because it feeds itself the guard the endpoint never passes. The
release documents' "honest limitations" sections are unusually good and omit all of it. That
combination — a red gate, a hollow gate, and a confident report — is what an early ship looks like
from the outside.

---

## Appendix — after reading the other reviewers (written last, wall respected)

Everything above was written before I opened any other report. Having now read them, here is what I
would revise, what was corroborated, and — most importantly — what I found that nobody else did.

### Corroborated by independent reviewers (raises confidence, changes nothing)

- **CHAL-001(a)** = Reviewer A's **P0-2** ("The Coach's action-legality guard fails open on 4 of its
  5 surfaces"), with identical file/line evidence: `coach.ts:153` optional field, `coach.ts:556`
  fail-open, `equity-worker.ts:105-120` `CoachTask` has no field for it, only `ws/router.ts:653`
  supplies it. Two reviewers reaching the same mechanism from different directions is the strongest
  form this evidence can take.
- **CHAL-007** = the same finding's closing paragraph, in almost the same words.
- **CHAL-003** = **P0-1** ("Shipped offline fixtures publish wrong learner-visible mathematics"),
  found independently by A, C and H. **They found more than I did**: `scenarios.ts:1001` ships
  `EV(check) = 0` derived as "it is worth the same as folding right now", where the truth is
  **180.62 chips** — the exact fallacy `evOfCheck` was rewritten to kill. I missed that one; it
  should be counted with my four.
- **CHAL-005** = **PROD-016 FAIL · P1**; **CHAL-006** = **PROD-011 FAIL · P1**, with the same
  `grep -rn "inviteCode" apps/web/src` → zero matches.

### Where I was wrong, corrected in place above

Listed first, and separately, because a challenger who only reports what it got right is not
auditing itself.

1. **Failure count: I said 3, the truth is 2.** Four reviewers said 2; I re-ran
   `pnpm run test:integration` with my own servers stopped and got `534 / 532 / **2** / EXIT=1`.
   Corrected in the verdict table, in CHAL-004, and in CHAL-008.
2. **CHAL-008 misdiagnosed.** Not order-dependence — **load sensitivity**. Re-diagnosed as a race
   between hand settlement and the next deal, downgraded **P1 → P2**. My counts (P1 4→3, P2 3→4)
   are updated.
3. **CHAL-006 over-listed two paths.** `/rooms/:roomId/sit` and `/rooms/:roomId/leave` are absent
   from `API_PATHS` **by design** (`api-paths.ts:106` — they go over the socket). Withdrawn.
4. **CHAL-009 route count needed scoping.** Six routes is the **default** invocation
   (`crawlDepth: 1`, `maxRoutes: 12`); a reviewer passing `--crawl-depth 2 --max-routes 40` reaches
   40. Restated so the finding is about the shipped command, which is the only defensible version.
5. **My Learn PASS was too generous** — API-level, not product-level. `quizAttempt` has no call site
   in the web app; I verified this myself rather than taking it on report. Downgraded to PARTIAL.
6. **CHAL-002 novelty narrowed.** The *mechanism* — `fold` graded "not consistent" because
   `DEFAULT_ASSUMED_FOLD_EQUITY = 0.35` inflates the aggressive line inside `isDefensible` — was
   found independently on two other scenarios. What remains mine is the instance that matters most
   pedagogically and the over-stack acceptance (below).
7. **CHAL-012's "6 of 35"** was already noticed and explained away by a maths reviewer as a
   boundary-count shift. Keep it as cosmetic; the "8 source trees vs 7" and the incomplete `verify`
   step list stand.
8. **CHAL-011's risk is latent, not active.** Three reviewers independently rebuilt the packages to
   scratch output directories and diffed: `dist` is currently **byte-identical** to a fresh build.
   The hermeticity hole is real and unreported elsewhere, but nothing is being masked by it today.

### What I would revise

- **CHAL-009 (a11y) — downgrade the conclusion, keep the finding.** Reviewer F ran a real Chrome
  audit with a self-validating harness (it discarded runs where `focusVisibleCount` did not equal the
  tab-stop count, and documented eight rejected false positives) and graded **24 PASS / 7 PARTIAL /
  0 FAIL** across 31 UX+A11Y requirements — including WCAG 2.2 SC 2.4.11 and 2.5.8 as PASS, which I
  had said nothing exercised. That evidence is far stronger than mine and I defer to it on the
  *state of the app*. My finding was about the *shipped gate*, and it stands unchanged and is
  endorsed by F's own §1: the repo's own tooling "**cannot** establish these results". Restated:
  the app appears largely accessible; the release gate cannot show that, and `test:a11y` is still
  not in `verify`.
- **CHAL-003 vs UX-010.** Reviewer F graded "no silent fallback to fake data" **PASS**, and that is
  correct on its own terms — the fallback is *labelled*. It does not contradict my finding: F checked
  that the banner appears, I checked what the numbers behind the banner say. Both are true, which is
  why the fixture defect survived a passing UX audit.
- **CHAL-001, count.** A measured "3 shipped scenarios leave no opponent with chips behind, 2 publish
  an illegal raise as the headline". I measured **4** with fold equity assumed against an all-in
  opponent (`eq-rule-of-four-big-draw-flop`, `eq-set-on-connected-flop-jam`,
  `rk-nine-big-blinds-call-or-fold`, `rk-when-survival-outweighs-chip-ev`), **all four** with
  `raise` as the headline suggestion, and **7 of 36** affected once the sizing defect is included.
  I stand by the higher numbers; the enumeration script and all 36 saved payloads are in my scratch
  dir.

### What nobody else found — and why it matters more than the overlap

**1. `CHAL-001(b)` — the `heroStack` units mismatch is a second, independent defect, and the agreed
fix for P0-2 does not fix it.**

No other report mentions `maxTo = heroCommittedThisStreet + heroStack`, the total-vs-behind
mismatch, or any of the five affected scenarios — `fl-heads-up-blind-reversal`,
`rk-high-spr-same-top-pair` and `fl-big-blind-option-limped-pot` appear in **no** other audit file.
Reviewer B examined `maxTo` and passed it (ENG-005), correctly: the **engine's** bounds are right.
The defect is in `@prl/poker-math` consuming `heroStack` as chips-behind while
`packages/content/src/scenario-analysis.ts:123` passes the seat's **total** stack.

This matters operationally. The remediation everyone is converging on — thread `legalActions` into
`CoachTask` — has no effect here, because a *described* scenario has no `HandState` to ask. After
that fix, `rk-high-spr-same-top-pair` will still offer "raise to 1455" from a 1400 stack, and
`fl-heads-up-blind-reversal` will still suggest 1000 from 995. **A fix for P0-2 that is verified only
against the all-in cases will close the review and ship this.** The check to add is the arithmetic
one: for every scenario, assert `candidate.cost <= heroStack - heroCommittedThisStreet`.

**2. `CHAL-002` — the downstream consequence, which is the one a learner actually experiences.**

Reviewer A exercised `POST /content/scenarios/:id/attempt` on `rk-the-fold-that-feels-wrong` and
graded the flow PASS, explicitly deferring content correctness. Nobody ran it on
`rk-when-survival-outweighs-chip-ev`, the scenario whose entire lesson is that folding can be right.
It returns `consistentWithAnalysis: false` for `fold`, telling the learner they are **11 873.7 chips
behind** — a figure that exists only because the Coach priced a raise hero cannot make with fold
equity that cannot exist. And it **accepts `{"action":"raise","to":26000}` from a 24 000 stack** and
answers *"You sized it to 26000; the analysis priced 26000."*

Every other report frames the legality defect as "the Coach shows an illegal option". That
understates it. The product **grades the learner against the fabricated number and marks its own
lesson wrong** — a direct breach of "never teach something false", and the single fact I would put
in front of anyone arguing to ship.

**3. `db:verify` never executes.** `verify` is a `&&` chain with `db:verify` last, so while `test`
fails, the gate REPORT.md §4 describes as asserting "the **LIVE** schema's security properties" has
not run in the command the documents tell you to use. I did not see this consequence drawn
elsewhere.

### What others found that I missed

Recorded so my report is not read as a complete list. The two that would have changed my P0 set:

- **A shutdown defect (Reviewer G, P0).** `ws/hub.ts:189` sets `clientTracking: false`, so
  `defaultPreClose` is a no-op and `app.close()` never resolves: one idle WebSocket → 10.18 s then
  exit 1; `docker compose stop` → **exit 137, SIGKILL**. The RUNBOOK claims the opposite and calls
  it fixed, and `shutdown.test.ts` passes 3/3 while containing **zero** WebSockets — the same
  hollow-gate shape as CHAL-007. I tested the socket path extensively and never tested shutdown.
- **A documented restore procedure that breaks the database (Reviewer G, P0).** RUNBOOK §11.4's
  `pg_dump --no-owner --no-privileges` + `pg_restore` yields a database that fails the runbook's own
  next command (`db:verify` → `prl_app: lacks USAGE`), with no re-grant step documented.

Also worth carrying: quiz attempts never submitted and lesson completion never written (so both
progress paths are structurally dead in the UI); no dead-button rule — 6 players paid the big blind
twice in a row over 40 hands with roster churn; three supply-chain gates that **cannot fail**
(`dep-shapes.mjs:50-66` matches 0/6 of pnpm's real emission patterns; install-hook/IOC checks pass
while inspecting zero packages; `lib.mjs:171` exempts every `@prl/*` name — on an **unregistered npm
scope**, which is a dependency-confusion hole); 86 % of the "integration" suite never touches
Postgres; and the reachability guard is itself defeatable by `exit 0` scripts and `describe(…,
{skip})`. My CHAL-011 sits next to that last cluster.

Note that my `security:audit` PASS in the table above is a PASS of **exit code and output**, which
is all I checked. Reviewer E's finding that three of those eight gates cannot fail is not
contradicted by my run — it explains it.

### Net effect on my verdict

Unchanged: **FAIL — do not ship.** The corroboration on CHAL-001(a), CHAL-003, CHAL-005 and CHAL-006
means four of my findings are now confirmed by two or more independent reviewers. Correcting my
failure count from 3 to 2 does not soften that: `verify` exits 1 either way, and it does so on two
tests that fail identically on every machine anyone has run them on.

The findings that are mine alone — the `heroStack` double-count, the over-stack raise the attempt
endpoint accepts as consistent, and the false "no stored odds table" claim in the footer — are all
in the same blast radius as the round's agreed P0 and **none of them is closed by its agreed fix**.
That is precisely the failure mode a final challenger exists to catch: not a defect nobody saw, but
a defect that will survive the remediation everybody agreed on.

**The single check I would add before anyone declares CHAL-001 fixed:** for every scenario, assert
`candidate.cost <= heroStack - heroCommittedThisStreet`. Threading `legalActions` into `CoachTask`
will not make that assertion pass, and without it `rk-high-spr-same-top-pair` ships a raise to 1455
from a 1400 stack.
