# Remediation Challenger — Poker Risk Lab

**Date:** 2026-08-19
**Role:** adversarial re-verification of the post-remediation tree (`27ee118`) against the
pre-remediation baseline (`5ee3bc6`).
**Premise of the engagement:** the claim "`pnpm run verify` exits 0, all 11 gates green" is
treated as unproven. Every PASS below rests on evidence I produced at runtime; anything I could
not exercise here is marked UNVERIFIED rather than PASS.

**Information wall.** Before forming my view I read only `docs/audit/final-release-audit.md`, and
only to learn what the four P0s were. No `docs/audit/raw/*.md` was read until after every verdict
below was reached; §6 records what changed afterwards (nothing).

**Instruments.** My own database `prl_chal_r` (migrated and seeded fresh), API on 3901, all
harnesses written by me and kept in the session scratch directory:

| Instrument | What it does |
|---|---|
| `probe.mjs`, `t1..t5*.mjs` | authenticated HTTP client; drives `/math/coach`, `/content/scenarios`, `/content/scenarios/:id/attempt` |
| `shutdown.mjs`, `shutdown2.mjs` | spawns the real server, puts sockets into a named state, sends SIGTERM, measures wall time and exit code |
| `blinds2.mts`, `blinds3.mts`, `soak.mts` | drives `LiveTable` directly across a scripted and a randomised roster; checks chip conservation, blind charging, deal-in eligibility |
| `review2.mts`, `labels.mts` | replays a hand through `buildHandReview` and compares its reconstruction against the engine's own recorded rows |
| `render-probe.test.ts` | compiles and server-renders the real `CoachPanel`, scans every percentage in the markup |
| two full `pnpm run verify` runs | one healthy, one with a deliberately broken `DATABASE_URL` |

---

## 1. Verdicts on the four P0s

| P0 | Verdict |
|---|---|
| **P0-1** Coach prices / publishes / **accepts** / **grades against** illegal actions | **NOT CLOSED** — the *pricing and publishing* half is closed on all five surfaces; the *accepting and grading* half is not. |
| **P0-2** Shipped fixtures publish impossible figures | **CLOSED** for every numeric path, data and render. One residual gap: prose is unguarded (P2 below). |
| **P0-3** Graceful shutdown hangs on any WebSocket | **CLOSED for WebSockets.** **NOT CLOSED in general** — a bare TCP connection that sends nothing still costs 10.0 s and exit 1. |
| **P0-4** Release gate red, `db:verify` never executed | **CLOSED.** All 11 gates run, all report non-trivial work, and a failure genuinely propagates to exit 1. |

---

### P0-1 — NOT CLOSED

#### What is genuinely fixed

`CoachInput.legalActions` is still optional, but the fail-open filter is gone: `buildCoachReport`
now resolves `input.legalActions ?? deriveLegalActions(input)`
(`packages/poker-math/src/coach.ts:672`), and all five surfaces pass a list explicitly —
`ws/router.ts:653` (engine's own), `routes/content.ts:338`, `calc/parse.ts:691`,
`review/build-review.ts:762`, `rooms/bots.ts:862` (derived). `CoachTask.legalActions` is required
(`workers/equity-worker.ts:132`) and `pool.ts:167` re-checks the reply against the request.

Runtime evidence I produced:

* `POST /math/coach`, 10 spots. With `opponentStacks:[0]` (every opponent all-in) the report
  contains **only** `fold` + `call`; with a live opponent the same spot produces three raise rungs.
  Hero stack ≤ `toCall`, hero stack 0, two opponents both all-in — all correctly withhold
  aggression. Omitting `opponentStacks` defaults it to hero's stack, which is documented.
* **All 36 bundled scenarios**, recomputed independently from the scenario JSON: I derived
  `toCall`, `heroCommittedThisStreet`, `maxTo` and the opponents' chips-behind myself and checked
  every published candidate against them. **0 of 36** publish an action or a `to` the spot cannot
  support. `fl-big-blind-option-limped-pot` (toCall 0, BB has a live bet out) correctly offers
  `check/fold/raise` and not `bet`.
* The live table refuses illegal sizes at the engine: from a 1,000 stack with `maxTo = 1000`,
  raises to 1001, 26000, 100000, 19 and 0 are all `illegal_action`.

#### What is still open — the attack that made P0-1 a P0

The audit's own headline reproduction was *"it accepts `{"action":"raise","to":26000}` from a
24,000 stack."* The action **name** is now filtered. The **size** is not.

```
POST /api/v1/content/scenarios/eq-flush-draw-turn-small-bet/attempt
{"action":"raise","to":100000}          # hero stack 500, maxTo 500, priced rungs 67 / 138 / 500

200 OK
{"consistentWithAnalysis": true,
 "reasoning": "raise is consistent with this analysis. EV(raise) = ... = 51.44 chips.
               Risks 67 to win 145. ... You sized it to 100000; the analysis priced 67. ..."}
```

`{"action":"raise","to":26000}`, `{"to":1}` and `{"to":0}` on the same scenario all return
`consistentWithAnalysis: true` and are graded against the **quarter-pot raise to 67** — the most
favourable raise on the table. Only `to: -500` is refused, by a schema `min: 0`.

Mechanism: `candidateFor(report, action, to)`
(`packages/poker-math/src/consistency.ts:73`) returns the exact `to` match when there is one and
otherwise **silently falls back to the highest-EV row for that action name**. Its own doc justifies
that fallback for the case where `to` is *absent*; the code also applies it when `to` is *present
and unmatched*. `judgeConsistency` has no branch for "the size you named is not one this analysis
priced", and no caller checks `to` against `heroCommittedThisStreet + heroStack`.

The consequence is the one the audit named: the boolean written to
`scenario_attempts.matched_expected`, and the verdict the learner reads, say a raise they could not
make was correct — measured against a number computed for a different raise. The sentence "You
sized it to 100000; the analysis priced 67" is present and is an improvement, but it sits under a
`true`.

**Severity: P0** on the audit's own definition of the cluster (*"accepts and grades against actions
the learner cannot legally take"*). **This residual is pre-existing, not a regression** —
`candidateFor` behaves identically at `5ee3bc6`. It was simply not reached by the remediation,
because the remediation closed the *action-name* half only.

**One-line repro:** `curl -X POST .../content/scenarios/eq-flush-draw-turn-small-bet/attempt -d
'{"action":"raise","to":26000}'` → `consistentWithAnalysis: true`.

**Content-data interaction, checked and clean.** The remediation also changed 12 scenarios'
`stack` values and redefined `stack` as chips *behind* (`packages/content/src/validate.ts` min
1 → 0, plus a new `checkSituationCoherence`). I checked whether the legality filter was made to
pass by editing the data rather than the code: it was not — the two all-in seats
(`eq-rule-of-four-big-draw-flop`, `eq-set-on-connected-flop-jam`) are narrated as all-in in the
prose, and the new coherence check *requires* `stack: 0` for a narrated all-in, which is a
narrower rule than the one it replaced.

---

### P0-2 — CLOSED (numeric), with an unguarded prose path

**Data half.** `pnpm run fixtures:check` → *"web fixtures are already the analysis the engine
produces today"*, exit 0. `apps/api/test/web-fixture-figures.test.ts` recomputes both fixtures from
`buildCoachReport` / `buildHandReview` and is inside the `test` gate. I scanned every string in
`packages/content/data/**` and `apps/web/src/fixtures/*.ts` for a percentage above 100: the only
two hits (`3600.0%`, `6000.0%`) are inside JSDoc comments describing the old defect, not in
rendered data.

**Render half — proved with the real component.** I compiled `packages/ui/src` with the package's
own `tsc` and server-rendered `CoachPanel` against a real server report, then poisoned it:

| Poison | Impossible percentages in the rendered markup |
|---|---|
| control (untouched server report) | `[]` |
| `ruleOfThumb.estimate = 1.6` (the exact shipped defect), `heroEquity = 1.8`, `breakEvenEquity = 2.5`, `perPlayer.equity = 3.6`, `potShareIfCalled = 1.9` | `[]` |
| the same figures written into **prose** fields | `["250.0%","180.0%","900.0%","140.0%","160.0%","160.0%","135.0%"]` |

So the numeric guard (`packages/ui/src/probability.ts`, consumed by `CoachPanel`, `EquityBar`,
`Metric`, `UncertaintyNote`) genuinely holds, including in `aria-label`s and bar widths.

**Residual (P2).** Every prose string on the same panel — `ruleOfThumb.note`,
`outs.explanation`, `potOdds.explanation`, `stackContext.explanation`, `candidate.derivation`,
`suggestion.headline`, `assumptions[]`, `teachingNotes[]` — is rendered verbatim with no
sanity check. I traced each producer and all are currently bounded by construction
(`maximumOutsForRuleOf24` caps the rule-of-2-and-4 note at 100 %; `alpha` and
`minimumDefenceFrequency` are `b/(pot+b)` and `pot/(pot+b)`). Content-bundle prose
(`scenario.reasoning`, `assumptions`, lesson bodies) is hand-authored and has **no** percentage
validation at all. So: **no reachable impossible percentage today**, but the defence-in-depth the
fix was written to provide covers only half the panel, and the half it does not cover is the half a
human types.

---

### P0-3 — CLOSED for WebSockets, NOT CLOSED in general

Measured by spawning the real server (`SHUTDOWN_GRACE_MS=10000`, the compose value), putting one
connection into a named state, sending SIGTERM and timing the exit.

| Socket state | Time | Exit |
|---|---:|---:|
| idle, no sockets | 0.011 s | 0 |
| 1 idle authenticated WebSocket (no `hello`) | 0.010 s | 0 |
| 1 WebSocket, seated, **mid-hand** | 0.044 s | 0 |
| 5 idle authenticated WebSockets | 0.011 s | 0 |
| 1 WebSocket whose peer **never answers the close frame** | 1.014 s | 0 |
| 1 **refused** upgrade whose peer keeps the socket | 0.608 s | 0 |
| complete WS upgrade headers, peer never reads or writes | 0.214 s | 0 |
| complete `GET /api/v1/health`, keep-alive idle | 0.019 s | 0 |
| **bare TCP connect, zero bytes sent** | **10.022 s** | **1** |
| **partial `GET /health` (no final CRLF)** | **10.022 s** | **1** |
| **partial WS upgrade headers (no final CRLF)** | **10.024 s** | **1** |
| **`POST` with `Content-Length: 200` and no body** | **10.017 s** | **1** |

The WebSocket defect is genuinely fixed, including the two states I expected to still hold it open
(unanswered close frame, refused upgrade) — both are bounded by `closeHandshakeGraceMs`.

But the P0-3 *signature* — full grace burned, exit 1 — is still reachable by **any peer that opens
a TCP connection and never completes an HTTP request**, with no session, no origin check and no
WebSocket involved. `apps/api/src/server.ts` is **unchanged** from the baseline: its idle sweep
calls `server.closeIdleConnections()`, which only drops connections that have *finished* a request.
A connection that has never had one is never idle, so it is never dropped, and
`http.Server#close()` waits the whole grace.

This is not exotic. A browser preconnect socket, a proxy or LB warm connection, a slow client and a
half-open connection after a network blip all present exactly this way, and `docs/RUNBOOK.md`
§Operations tells the operator that a non-zero exit means *"the drain genuinely failed … fix the
drain"*. `stop_grace_period: 30s` (added by the remediation) means this now presents as exit 1
rather than SIGKILL 137, which is a real improvement, but it is still a failed deploy signal from a
connection anyone can open.

`apps/api/test/shutdown.test.ts` now covers WebSockets properly (open socket → 4503 + exit 0;
peer that never answers the close frame). It has no case for a connection that never completes a
request, which is why the suite is green.

**Severity: P1.** **One-line repro:** `nc 127.0.0.1 3901` (connect, type nothing), then
`kill -TERM <api-pid>` → 10.0 s, exit 1.

---

### P0-4 — CLOSED

`verify` is no longer an `&&` chain; it is a loop that runs every gate, reports each, records
failures and exits 1 if any failed.

**Run 1 — healthy `DATABASE_URL` (my own database), exit 0.** All eleven gates ran in order and all
reported non-trivial work, which I checked individually rather than trusting the PASS line:

| Gate | Evidence it did something |
|---|---|
| `security:audit` | 9 sub-gates, 162 versions, 104 on-disk + 58 registry-checked, 10,547 files swept |
| `security:hygiene` | 451 source files, 202 `src/` files scanned for `Math.random` |
| `lint` / `build` / `typecheck` | ran, exit 0 |
| `design:contrast` | token layer + rendered layer both PASS |
| `test` | 6 packages + web (133/21/241/237/28/148/101), API 640, scripts 102 — 0 failures |
| `test:a11y` | 7 routes, 0 violations |
| `test:exhaustive` | 133,784,560 hands in 6.5 s |
| `test:simulation` | ran, exit 0 |
| `db:verify` | 121 columns, 41 indexes, 13 tables, schema + relation owners |

**Run 2 — same command, `DATABASE_URL` pointed at a database that does not exist.** This is the
test the audit's finding actually calls for, because the old failure was "a gate did not run":

```
=== FAIL test ===
=== PASS test:a11y ===          <- gates AFTER the failure still ran
=== PASS test:exhaustive ===
=== PASS test:simulation ===
=== verify gate: db:verify ===
  ✗ script: database "prl_chal_r_does_not_exist" does not exist
=== FAIL db:verify ===
=== verify FAILED. These gates did not pass: test db:verify ===
exit 1
```

So: failures do not stop the run, they *are* reported, they *are* summarised by name, and they
*do* produce exit 1. `db:verify` genuinely executes and genuinely fails. The `test` gate genuinely
depends on a live Postgres, which also disproves the possibility that its database-backed tests
silently skip.

**Attempts to find a gate that cannot fail, and what I found:**

* A missing script name would make `pnpm run <gate>` non-zero → FAIL. Fails closed.
* The inner `&&` chain in `test` fails closed (a broken `build:packages` fails the gate).
* `pnpm -r ... test` silently skips a package with no `test` script — but
  `apps/api/test/workspace-test-reachability.test.ts` enumerates every workspace manifest, every
  root script, every `node --test` glob and **the `verify` gate list itself**, and carries negative
  controls for the three known bypasses (`echo && exit 0`, a `.test.ts` with no `test()`,
  `describe(…, {skip: <literal>})`).
* **One real weakness (P3):** `scripts/a11y-audit.mjs` starts the web app on a hard-coded port
  3000 and treats *any* HTTP answer at that port as "ready" (`waitUntilReady`, "Any HTTP answer
  means the server is listening"). It checks `this.exited` first, but the fetch to an already-
  occupied port succeeds on the first iteration, long before its own `next start` could exit with
  `EADDRINUSE`. On a machine where something else holds 3000, `test:a11y` audits the foreign
  server and passes. Code-read only — I did not bind port 3000, because it is not one of my
  assigned ports and another run could have been using it. **UNVERIFIED at runtime.**

---

## 2. Regressions and defects the remediation introduced or left behind

### R1 — P1 — Hand review silently loses its entire analysis for any hand with a dead small blind or a dead button

The new dead-button rule (`packages/poker-engine/src/positions.ts`, `apps/api/src/rooms/table.ts`)
creates two legitimate new hand shapes: a **dead small blind** (nobody posts it) and a **dead
button** (it sits in an empty chair). `apps/api/src/review/build-review.ts` was not updated:
`openReplay` at `:594` still re-derives the blinds with `assignBlinds(hand.button_seat, …)` — the
very function `positions.ts` now documents as *"correct for ONE hand and wrong for a sequence of
them the moment the roster changes."*

Measured, driving the real `LiveTable` into a dead-SB hand and then feeding the engine's own
recorded rows to `buildHandReview`:

```
### CONTROL: normal button
  button=0 dealt=[0,1,2,3]
  ENGINE actually posted:   seat1=5 seat2=10   (pot 15)
  REVIEW replay will post:  seat1=5 seat2=10   (pot 15)
  seq=1 preflop call: RECORDED potBefore=15 | ANALYSIS potTotal=15 toCall=10

### DEAD SMALL BLIND (the big-blind payer left before this hand)
  button=0 dealt=[0,2,3]
  ENGINE actually posted:   seat2=10           (pot 10)
  REVIEW replay will post:  seat2=5 seat3=10   (pot 15)
  SKIPPED: {"sequence":1,"reason":"the replayed pot disagrees with the persisted pot"}
  SKIPPED: {"sequence":5,...} {"sequence":8,...} {"sequence":11,...}
  seq=1 preflop call: analysis=null   (every hero decision)
```

It **fails safe** — a pot cross-check catches the divergence and refuses rather than publishing a
fabricated price, which is why this is P1 and not P0. The cost is that the product's central
teaching surface for hand review is silently empty for a class of hands the remediation itself
created. A dead button hits the earlier guard (`!dealt.includes(hand.button_seat) → return null`)
and produces the same outcome. In a 45-hand run with an ordinary join/leave schedule I saw 2 dead
buttons; dead small blinds arise just as often (any hand where the previous big blind leaves).

No test covers hand review under either shape: `table-blinds.test.ts` and `blind-rotation.test.ts`
cover the engine and the table, and stop there.

**One-line repro:** deal three hands 4-handed, stand up the player who paid the big blind, deal
again, then `buildHandReview` the resulting hand — every `decisions[].analysis` is `null` with
`reason: "the replayed pot disagrees with the persisted pot"`.

### R2 — P2 — The hand-replay page labels the wrong seats on a dead-small-blind hand

`positionLabels` gained a fourth argument in this remediation so a hand dealt under the dead-button
rule can state its blinds instead of having them re-derived. `packages/poker-engine/src/redact.ts:203`
uses it. The two web call sites do not:

* `apps/web/src/lib/hand-replay.ts:439` — 3 args
* `apps/web/src/lib/scenario-view.ts:111` — 3 args

Measured for the dead-SB hand above (button 0, dealt [0,2,3], engine posted only a big blind at
seat 2):

```
hand-replay.ts derives: [[0,"BTN"],[2,"SB"],[3,"BB"]]
truth:                  [[0,"BTN"],[2,"BB"]]   (seat 3 posted nothing; the SB is dead)
```

The review page therefore badges the big-blind payer as the small blind and badges a player who
posted nothing as the big blind. `recoverBlinds` in the same file compounds it: with one forced bet
it returns `{small: 10, big: 10}`, so the replay's `TableConfig` claims a small blind of 10 and
feeds `minimumRaiseTo` from it. A dead **button** makes `positionLabels` throw
(`"button seat 1 is not occupied"`); both call sites catch it and degrade to no labels at all.

### R3 — P2 — `RoomMember.awaitingBigBlind` reaches the client and is never rendered

The field was added so a seated player who receives no cards is explained. Its own contract doc
(`packages/contracts/src/api-types.ts:422`) says: *"Without this field that is invisible …
which reads as a bug in the table."* `apps/web/src/lib/table-socket.ts:439` validates it on every
frame. **No component reads it** — `LiveTable.tsx` uses `room.members.length` only, and neither
`TableStage.tsx` nor any UI component references `awaitingBigBlind`. So the symptom the field was
introduced to prevent is still exactly as visible as before. Server-side behaviour is correct
(verified below); it is the render that is missing.

### R4 — P2 — Three release documents assert a gap the shipped code has closed, with a transcript that is not this tree's output

`apps/api/scripts/verify-schema.mjs` gained check 7: schema owner and every relation owner must be
`prl_migrator`. I rehearsed the documented broken restore end to end — dump, `migrate.mjs roles`,
`pg_restore` as `prl_api` without `--exit-on-error` — and reproduced it exactly:

```
pg_restore: warning: errors ignored on restore: 20        (exit 0)
schema prl owner: prl_api;  relations in prl: prl_api × 54
```

`db:verify` against that database:

```
✗ schema ownership: schema prl is owned by prl_api, not prl_migrator …
✗ relation ownership: 13 relation(s) in prl are not owned by prl_migrator …
exit 1                                    (against the healthy database: exit 0)
```

The gate catches it. But the shipped documents still say it does not:

* `docs/RUNBOOK.md` §11.4 — a blockquote headed *"**And `pnpm run db:verify` exits 0 on that
  database.** Measured 2026-08-19"*, telling the operator the release gate *"cannot see this
  particular broken restore"* and to run two SQL queries by hand instead.
* `docs/VERIFICATION.md` — *"**Not checked at all** … `pnpm run db:verify` exits **0** (measured
  2026-08-19). Closing it is one query in `apps/api/scripts/verify-schema.mjs`"* — a fix that is
  already in the file.
* `docs/REPORT.md:245` — *"the command the checklist says to trust as the rehearsal exits 0 on a
  database whose …"*.

And the §11.4 "rehearsed end to end on 2026-08-19" transcript reads:

```
· 118 columns across the prl schema        actual: 121
· 41 indexes                               actual: 41
· checked 12 tables for prl_app privileges actual: 13
                                           (and the "checked schema and every relation owner"
                                            line, which check 7 always prints, is absent)
```

That is the **pre-remediation** tool's output presented as a same-day rehearsal of the shipped one.
The audit's own `CHAL-012`/`OPS-015` finding was documentation overclaiming evidence; this is the
same defect inverted, in a runbook, on the disaster-recovery path.

### R5 — P3 — `test:a11y` can pass against a foreign server

See P0-4 above. Code-read only, **UNVERIFIED at runtime**.

### R6 — P3 — Stale header comments in both shipped fixtures

`apps/web/src/fixtures/scenarios.ts:33-38` and `review.ts:43-46` still say
*"`equity.ruleOfThumb.estimate` is divided by 100 on the way in … the untouched value prints as
'3600.0%' … the defect is reported upstream"*. The unit disagreement was fixed, the generator does
no such division, and the equivalent helper was deliberately removed from
`web-fixture-figures.test.ts` with a comment explaining why. Two files now document a workaround
that no longer exists, in the files a future maintainer reads first.

---

## 3. Things I attacked and could not break

Recorded because a challenger that only lists defects misrepresents the work.

* **The blind rules are correct.** I wrote my own fixtures rather than reading the repo's. Over a
  scripted 45-hand run with 10 join/leave events across 6 seats: **no player paid the big blind
  twice in a row**, the big blind advanced by exactly one live player every hand, **no waiting
  player was ever dealt in except on the hand where they posted the big blind**, dead buttons
  appeared and were correctly left in empty chairs, and dead small blinds were correctly not
  posted and not moved onto the next player. Heads-up transitions in both directions (3→2, 2→3),
  a player who stood up owing a blind and returned in a *different* seat (debt survived, keyed by
  user id), and the documented two-handed restart policy all behaved as specified.
* **Chip conservation holds.** A 250-hand randomised soak with roster churn, random legal actions
  including bets, raises and all-ins, and chips banked while players were away from the table:
  **190 hands dealt, 0 chip leaks.** The two anomalies my detector flagged were both my
  instrument's fault (a short all-in big blind posting less than a full blind, and the documented
  two-handed restart), confirmed by tracing each one.
* **The live table cannot be made to accept an illegal size.** Raises to `maxTo+1`, 26000, 100000,
  `minTo-1` and 0 are all `illegal_action`.
* **The WebSocket shutdown states I expected to still hang do not** — mid-handshake WS upgrade
  that completes, refused upgrade, peer that ignores the close frame, five sockets, a socket
  mid-hand: all exit 0 well inside a second.
* **The numeric render guard is real**, including the exact `estimate: 1.6` that shipped, and
  including `aria-label`s and CSS widths.
* **`verify` genuinely fails.** Two full runs, one green and one deliberately broken.

---

## 4. Direct answer

> **Is `verify` exiting 0 an honest signal, or is something passing that should not?**

**The gate itself is honest. What it covers is not the whole of what was claimed fixed.**

`verify` does what it now says it does: eleven gates, every one executed, every one reported, a
failure anywhere producing exit 1 with the failing gates named — I proved both directions. `db:verify`
runs and fails for real. No gate I examined passes over zero work. On the specific mechanism P0-4
described, the signal is trustworthy, and I could not construct a gate that silently does not run.

But three things pass through it that should not, and none of them is the gate's fault — they are
outside its reach:

1. **P0-1 is only half closed and the suite cannot see it.** `POST
   /content/scenarios/:id/attempt` still returns `consistentWithAnalysis: true` for
   `{"action":"raise","to":26000}` from a 500-chip stack, graded against a 67-chip raise. That is
   the audit's own headline reproduction, in a different scenario, and the green suite contains no
   test that submits an unpriceable size.
2. **P0-3's failure signature is still reachable** by a peer that opens a TCP connection and sends
   nothing — 10.0 s, exit 1. The shutdown suite was extended to cover WebSockets and stops there.
3. **A new P1 rides in under the green.** The dead-button rule created hand shapes
   `build-review.ts` cannot reconstruct, so hand review silently publishes no analysis for them,
   and the replay page badges the wrong seats. Nothing tests review under a changed roster, so
   nothing went red.

So the honest reading of "verify exits 0" is: *the eleven checks that exist all pass, and they are
now genuinely all run.* It is not evidence that the four P0s are closed. Two of the four are not.

---

## 5. Severity summary

| ID | Severity | Finding |
|---|---|---|
| RC-1 | **P0** | Scenario attempt accepts and grades a raise `to` the learner cannot make; `candidateFor` falls back to the most favourable priced row. Pre-existing; not reached by the remediation. |
| RC-2 | **P1** | Graceful shutdown still burns the full grace and exits 1 on any connection that never completes an HTTP request. `server.ts` unchanged from baseline. |
| RC-3 | **P1** | Hand review publishes no analysis at all for dead-small-blind and dead-button hands — a shape the remediation itself introduced. Fails safe. |
| RC-4 | **P2** | Hand-replay and scenario-view label the wrong seats (and recover a wrong small blind) on dead-blind hands; `positionLabels`' new `blinds` argument is unused by both. |
| RC-5 | **P2** | `RoomMember.awaitingBigBlind` is carried and validated but never rendered — the invisibility it was added to fix is unchanged. |
| RC-6 | **P2** | RUNBOOK §11.4, VERIFICATION.md and REPORT.md assert a `db:verify` blind spot that is closed, and §11.4's "measured 2026-08-19" transcript is the pre-remediation tool's output (118 columns / 12 tables vs 121 / 13). |
| RC-7 | **P2** | The `CoachPanel` probability guard covers numeric fields only; every prose field is rendered verbatim, and content-bundle prose has no percentage validation. No reachable violation today. |
| RC-8 | **P3** | `test:a11y` binds a hard-coded port 3000 and treats any answer there as its own server; it can audit a foreign app and pass. UNVERIFIED at runtime. |
| RC-9 | **P3** | Both shipped web fixtures carry header comments describing a divide-by-100 workaround that no longer exists. |

---

## 6. After the wall

Having reached the verdicts above I read `docs/audit/raw/challenger.md` to check attribution on
RC-1. The original `CHAL-002` reproduction (`{"action":"raise","to":26000}` from a 24,000 stack,
answered *"the analysis priced 26000"*) worked because the illegal raise was itself **priced**, so
`candidateFor` found an exact match. That path is genuinely closed: the scenario now carries
`heroStack: 22000` with `toCall: 22000` and no raise is offered, and submitting `raise` there
correctly returns *"raise is not one of the actions available in this spot."* My finding is the
*other* half of the same line of code — an unmatched `to` on a spot where raise **is** legal —
which the original challenger did not test and the remediation did not close. I would not revise
any verdict above.

I did not read the remediating engineers' own reports before writing this; nothing in the sources
I did read changes a measurement here.
