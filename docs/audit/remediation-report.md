# Remediation Report

**Audit:** 2026-08-18 — verdict **RELEASE: FAIL**, 4 P0 clusters and 17 P1 clusters over 208 requirements.
**Remediation:** 2026-08-18/19.
**Method:** thirteen engineers working disjoint file territories in three waves, plus a remediation
challenger and a browser journey verifier — both walled off from the fixers' reports — and a further
fix round driven by what they found.

This document records what changed and, more importantly, **what is still open**. It is written to
the same standard as the audit: a fix is not closed because someone fixed it, only because someone
independent measured it afterwards.

---

## 1. The headline

`pnpm run verify` — the declared release gate — **could not pass before this work**. It exited 1,
and because it was an `&&` chain that stopped at the first failure, four of its gates had never once
executed in the command the documentation tells operators to run.

It now runs **all eleven gates**, reports every failure rather than the first, and passes.

| | before | after |
|---|---|---|
| `pnpm run verify` | exit 1, 4 gates never reached | **exit 0, 11/11 gates** |
| `pnpm run test` | exit 1 — 1,282 tests, 2 failing | **exit 0 — 1,776 tests, deterministic** |
| assertions in the suite | 4,930 | **5,915** |
| gates in `verify` | 8 (4 unreachable after a failure) | **11, all reached** |
| supply-chain gates | 8, of which 4 could not fail | **9, each with a negative control** |

---

## 2. The four P0s

Each was re-verified by someone who did not fix it.

### P0-1 — The Coach priced, published, accepted and graded against illegal actions
**CLOSED, in two halves, and the second half was nearly missed.**

The *publishing* half: `legalActions` was optional and its filter read
`input.legalActions === undefined || …includes(action)`, so an absent list disabled the guard, and
the wire type behind four of the five surfaces had no field to carry one. Absence now derives a
conservative set; `CoachTask.legalActions` is required.
*Verified by the lead auditor across all 36 shipped scenarios: **0 candidates or suggestions outside
the legal set, 0 costing more than hero has behind.***

The *accepting and grading* half was **not** fixed by that work, and an independent challenger
proved it: `POST …/attempt {"action":"raise","to":26000}` with 500 behind returned
`consistentWithAnalysis: true`, graded against a 67-chip raise, because `candidateFor` silently
substituted the highest-EV row when the submitted size matched nothing. The blast radius was far
wider than that payload — the bet slider lets a learner submit almost any total, so **every unpriced
size was being graded against a different action**. Unpayable sizes are now refused; payable but
unpriced ones get an honest answer and a `NULL` record instead of a false verdict.

### P0-2 — Shipped fixtures published wrong figures, including "160.0%"
**CLOSED at both layers.**

The engine had already been hardened; only the fixture was never regenerated, because
**the repository contained no way to regenerate it** — the guard's failure message said "regenerate
the fixture" and no such command existed. `scripts/regenerate-web-fixtures.mjs` is that command
(`pnpm run fixtures:regenerate` / `fixtures:check`), and `packages/ui/src/probability.ts` adds a
render-boundary guard so no impossible percentage can reach a page from any source.

*Verified: `formatProbability(1.6) → null`, `(36) → null`, `(-0.1) → null`, `(1.0001) → null`,
`(0.35) → "35.0%"`. The challenger compiled and server-rendered the real `CoachPanel` with
`estimate: 1.6`, `heroEquity: 1.8`, `breakEvenEquity: 2.5` and `perPlayer.equity: 3.6` and found
**zero** impossible percentages in the markup. The journey verifier swept 75 rendered routes and
found none.*

### P0-3 — Graceful shutdown hung on any open connection
**CLOSED, in two halves.**

`clientTracking: false` made the library's close loop unreachable, so one idle WebSocket meant
10.18 s and exit 1, and SIGKILL under compose. Fixed with an explicit `preClose` that closes each
socket with code 4503.
*Verified by the lead auditor with a real authenticated session: **0.022 s, exit 0, client saw 4503**.*

The challenger then found the same failure signature on a **bare TCP connection that sends
nothing** — reachable by any health probe or port scan — because the drain only swept connections
that had *finished* a request. The drain now distinguishes work the server owes from work the client
owes. *Measured: bare TCP 10.025 s/exit 1 → **0.042 s/exit 0**; partial request 10.015 → **0.032**;
`Content-Length` with no body 10.021 → **1.027**.*

### P0-4 — The release gate was red, and `db:verify` never executed
**CLOSED.** `verify` is no longer an `&&` chain. *Verified by the challenger in both directions: with
a broken `DATABASE_URL`, `test` and `db:verify` fail, the gates after the failure still run, and it
exits 1 naming them. It could not construct a gate that silently does not run.*

---

## 3. What the independent verifiers found afterwards

Neither verifier was shown the fixers' reports. Both found things the fixers had not.

**The remediation challenger** proved two P0s were only half closed (above), and found a regression
the remediation had introduced: the new dead-button rule made **hand review publish no analysis at
all** for any hand with a dead small blind or button, because the replay still re-derived the blinds
from the button. Fixed by recovering the blinds from what was actually posted. Alongside it:
`scenario-view.ts` sized the table by *player count* rather than highest seat index, so **14 of the
36 published scenarios rendered with no position badges at all** — a defect no round of this audit
had noticed.

**The browser journey verifier** ran all nine critical journeys. Six complete, including the two the
audit called out specifically:

- **Private multiplayer with two genuinely independent browser sessions** — separate cookie jars,
  two distinct users, joined by the shown-once invite code, a hand played to showdown, redaction
  holding throughout.
- **Disconnect → reconnect mid-hand** — state restored exactly, the resync frame carrying hole cards
  only for the reader's own seat.

It also found that every remaining defect was **one pattern**: *a fallback path reporting the wrong
reason.* "Timed out" rendered as "does not exist". "No session" as "recorded". "Not in memory" as
"not your table". "Cannot reach the API" as a confident unit balance. For a product whose central
promise is that it never says more than it knows, that was the pattern worth fixing, and it has been:

| was | now |
|---|---|
| Hand review 404 "there is nothing at this address" for hands the API serves 200 | the deadline is set against the endpoint's own declared budget, and an outage says so |
| a guest told "the one it recorded as a question you have answered" — nothing recorded | `QuizAttemptResponse.recorded` carries the truth; the panel states it |
| after an API restart, "**Not your table**" for the learner's own room | the socket path reopens the room from the database, as the REST path already did |
| units badge showing a bundled `1,000` during an outage | `units — not available` |
| `/learn` warning readers off 9 of 17 working lessons | 0 |
| "**47 outs in total**" out of 47 unseen cards | the count refuses to call itself outs where none is possible |
| 60-second clock auto-folding a learner mid-analysis | a lone learner at a table of bots gets 240 s; bots and multi-human rooms unchanged |

---

## 4. Still open

Stated plainly, because a remediation report that closes everything is not a remediation report.

- ~~One intermittent test in the release gate.~~ **CLOSED, and it was not flakiness.**
  `ws-socket.test.ts:851` was asserting a **false invariant**: `stacks.some(stack => stack !== 1000)`
  tests a property of *a hand somebody won*, not of *a settled hand*. A **chopped pot** returns each
  seat exactly what it committed, so both stacks legitimately read 1,000. Reproduced deterministically
  — 2 failures in 40 unloaded runs, and 15 chops in 400 hands (3.75 %) for that line-up — with the
  captured terminal view showing two seats dealt, both blinds posted, the board playing for both, and
  `awards: 25 each, wasSplit: true`. The three guards that make a one-seat hand impossible were
  confirmed intact, and no product defect existed.
  The assertion was replaced by three strictly stronger ones (the blinds were posted; every chip in
  every pot is awarded; every seat closes on its starting stack **plus its net**), and the replacement
  was **mutation-verified**: withholding one seat's award in the engine's `settle` is invisible to the
  old predicate and caught by the new one. 60 consecutive runs clean.
  *This is the shape of the whole exercise: the "flaky test" was a wrong test, and the fix was to
  strengthen it.*
- **`ScenarioAttemptResponse` has the same honesty defect the quiz response just had** — it answers
  200 to an anonymous caller, stores nothing, and carries no `recorded` signal. Same shape, one
  endpoint over. Found while fixing the quiz; not in the audit.
- **`/learn`'s index still cannot show a reader their own progress.** The trade-off is now explicit
  and the copy is honest about it, rather than silently reporting everyone as having read nothing.
- **Legends compare can contradict itself** ("raise — most likely 60.0% … **This model prefers to
  fold** here"), and seat numbering is inconsistent across one screen. Both from the journey sweep.
- **`reopenFor` duplicates `openRoomFor`.** The rule belongs on `RoomRegistry`, where both transports
  already depend on it.
- **An ordering hazard in `RoomRegistry.seatBot`** (`registry.ts:779-787`): it awaits `table.sit(...)`
  and only then registers the bot with its runner. A `startHand` landing in that window would deal a
  bot in before the runner knows about it, and the table would sit on that bot's turn until the timer
  folded it. Practically unreachable today (a brand-new room with no sockets on it); found while
  chasing the chopped-pot failure and not the cause of it.
- A P3 tail from the journey sweep: the Coach says "chips" where the product says "units"; outage
  notices print internal API origins; a generic `<title>` on scenario pages.

---

## 5. Two things worth recording about method

**The most valuable finding of the whole exercise came from asking whether a check could fail.**
Reviewer E built a sandbox for each of the eight supply-chain gates and fed it real hostile input;
four could not fail, including both gates aimed at the campaign the policy was written for. "All 8
gates passed" was true and materially overstated what had been verified. Every gate now has a
negative control.

**The second most valuable came from re-testing a challenger's own claim.** The audit's final
challenger reported a `heroStack` total-versus-behind double-count as a P0 that would survive the
agreed fix. The lead auditor ran the Coach over all 36 scenarios, reproduced the surface symptom,
and then found the data settles it the other way — three scenarios total to exactly round starting
stacks. It was a false positive, withdrawn before it reached the report. An audit that absorbs its
challenger's findings without testing them is doing the thing it exists to prevent.
