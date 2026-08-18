# Poker Correctness Audit

**Audit date:** 2026-08-18
**Reviewers:** B (engine, adversarial rules) and C (mathematics), working independently and in
parallel; neither saw the other's conclusions before forming its own. Lead auditor verified the
release-blocking findings directly.

**Evidence standard.** Nothing in this document is graded on the existence of a function, a type
or a test. Both reviewers were required to construct their own fixtures and recompute reference
values from first principles, then compare the code against *those* — never against the repo's own
tests or constants.

---

## 1. Method, and why its results can be trusted

Reviewer B **mutation-tested its own probes** before trusting them: it built two deliberately
broken copies of the engine (one dropping the odd chip on a split, one setting
`reopens = raisedBetLevel` and having the heads-up button post the big blind) and confirmed the
probes failed loudly against both. A green result from a probe that cannot go red proves nothing;
these can go red.

Reviewer C wrote its **own** C(7,5)-subset hand evaluator, its **own** brute-force board
enumerator, and its **own** permutation-enumeration ICM, and compared the code against those. It
also rebuilt both packages and diffed against the shipped `dist/` (byte-identical), establishing
that the audited `src` is what actually runs.

Volume of independent evidence: 396 hand-derived assertions; a 50,000-hand soak (275,112 actions,
290,644 rejected illegal actions) checking invariants after **every** action; a 20,000-hand
differential (145,631 decision points) against an independently written model of the reopening
rule; 40,000 random 7-card evaluator pairs; a 1,712,304-board exact equity enumeration.

---

## 2. Result summary

| Area | Reviewer | PASS | FAIL | PARTIAL | UNVERIFIED |
|---|---|---:|---:|---:|---:|
| Engine / rules (ENG-001…023) | B | 18 | 1 | 4 | 0 |
| Mathematics (MATH-001…013) | C | 11 | 1 | 1 | 0 |

**There is no P0 in the engine or in the mathematics library.** Both P0s in this document live in
shipped *fixture data*, not in the computation.

---

## 3. Rules verified correct (with independently derived expectations)

| Requirement | Status | Evidence |
|---|---|---|
| ENG dealer/button basic movement | PASS | probes over multi-hand sequences |
| Blinds, incl. all-in for less than a blind | PASS | hand-computed postings |
| **Heads-up rules** | **PASS** | button = SB, acts **first** preflop and **last** postflop — verified including gapped seats and wrap-around. This is the most commonly botched rule in poker implementations; it is right here. |
| Turn ordering across streets and re-raises | PASS | 20,000-hand differential vs independent model |
| Legal action set at each decision point | PASS | 290,644 illegal actions correctly rejected |
| Minimum raise sizing | PASS | by **increment**, not doubling — correct |
| **Incomplete all-in raises** | **PASS** | an all-in larger than a call but smaller than a full raise correctly does **not** reopen the betting to players who already acted. Verified against an independently written reopening model over 145,631 decision points. |
| All-ins generally | PASS | incl. all-in for less than the current bet |
| **Multiple side pots** | **PASS** | four-way, four distinct stacks: every pot's **size** and its **eligible-player set** matched B's hand-computed values exactly |
| Ties / split pots, incl. side-pot-only ties | PASS | hand-constructed cases |
| **Odd chips** | **PASS** | deterministic, documented, and no chip created or destroyed |
| Winner determination at showdown | PASS | correct in all constructed cases |
| **Chip conservation** | **PASS** | invariant held after **every action** across a 50,000-hand soak (275,112 actions) |
| No card dealt twice | PASS | soak invariant |
| Rejected action leaves state byte-identical | PASS | soak invariant |
| `unbiasedInt` rejection sampling | PASS | bound is exact, **no off-by-one** — `limit-1` accepted / `limit` rejected verified for eight bounds |
| `Math.random` absent | PASS | absent from all 301 source files under a comment-stripping scan of B's own construction |
| Exhaustive 7-card evaluation | PASS | **133,784,560 hands in 7.6 s, 2/2 pass**; the nine expected constants are the correct published frequencies |

### Mathematics verified correct (independently recomputed)

| Requirement | Status | Independently derived check |
|---|---|---|
| Hand evaluator | PASS | 0 mismatches over 40,000 random 7-card pairs; wheel, steel-wheel-beats-quad-aces, counterfeited two pair, board-plays-ties all correct |
| Outs, incl. **clean vs dirty** | PASS | C's hand-derived 7-clean case (where 2h/3h fill the opponent up) reproduced exactly; card-by-card equity agreement to 1e-12 |
| Exact equity enumeration | PASS | **AA vs KK = 82.6366 %**, matched C's own 1,712,304-board enumeration bit-for-bit; AKs vs QQ = 46.2145 % |
| Monte Carlo + confidence interval | PASS | correct z = 1.96 half-width on pot share, verified against C's own derivation; **191/200 coverage** |
| Ties in equity | PASS | ½ heads-up, ⅓ three-way — exact, not approximated |
| Pot odds / break-even equity | PASS | **EV(call) is exactly 0.000e+0** at the break-even equity, at every size tested |
| Bluff fold equity | PASS | required fold equity round-trips through EV(bet) to zero within 1e-15; the alpha/MDF identity holds |
| ICM (Malmuth–Harville) | PASS | **60/40 for 3:1 stacks with 70/30 payouts is correct** — derived by hand *and* by full permutation enumeration |
| Risk of ruin, variance, SPR | PASS | match hand derivations |
| Rule of 2 and 4 | PASS | labelled an approximation everywhere; refuses to emit > 100 % |

---

## 4. The prior P0 is genuinely fixed

The previous review's most consequential finding was that **the Coach computed a raise's expected
value as though it were an opening bet** — an error of exactly `(1−f)·C·(1−e)`, always positive and
worse the lower the player's equity.

**Status: FIXED. Verified independently by Reviewer C.**

- `packages/poker-math/src/coach.ts:652` uses `evOfRaise`, and only uses `evOfBet` when
  `betLevel === 0`.
- Every raise candidate's EV matched C's own closed form
  `f·pot + (1−f)·[e·(pot+c+2r) − (c+r)]` to 1e-9.
- The delta from the old (wrong) bet formula was exactly `(1−f)·c·(1−e)` in every case
  (24.19 / 119.27 / 8.85 / 239.05 / 9.75 chips) — the predicted error term, confirming both the
  old diagnosis and the new fix.
- Across all 36 shipped scenarios: **0 EV mismatches, 0 suggestion mismatches**, and **5
  recommendations would flip back to a wrong `raise`** under the old formula.

---

## 5. Findings

### P0-1 — Shipped offline fixtures publish wrong learner-visible mathematics
**Status: FAIL.** Found independently by reviewers **A, C and H**, and verified directly by the
lead auditor. This is the strongest convergence in the audit.

`apps/web/src/fixtures/*.ts` are rendered by the Lab and Review screens whenever the API is
unavailable (`isApiUnavailable`: a transport error **or any 5xx**). They were regenerated for the
raise-EV fix but **not** for three later fixes, so they now carry values the engine refuses to
produce:

| Location | Ships | Truth today |
|---|---|---|
| `apps/web/src/fixtures/scenarios.ts:959-962` | `ruleOfThumb.estimate: 1.6` → panel prints **“The rule of 2 and 4 estimates 160.0%”** | engine returns `ruleOfThumb: null` |
| `apps/web/src/fixtures/scenarios.ts:1001` | `EV(check) = 0`, derived as *“it is worth the same as folding right now”* | **180.62 chips** — this is the exact fallacy `evOfCheck` was rewritten to kill |
| `apps/web/src/fixtures/review.ts:450` | a **60 %** draw, on a panel simultaneously printing “8 clean, 7 dirty, 15 total” | engine computes **32 %** — a 28-point overstatement |
| `apps/web/src/fixtures/scenarios.ts:618` | rule-of-2-and-4 error **direction inverted** (“understates by 2.4”) | actually **overstates** by 1.0 |

**Why the 160 % case is the headline.** The engine was *already* hardened against exactly this:
`packages/poker-math/src/coach.ts:271-278` returns `already-ahead` / `no-clean-outs` /
`not-a-probability`, and `:375-382` `assertProbabilityFraction` **throws** on anything outside
`0..1`. Its own comment names the bug class: *“a hand with 45 ‘outs’ was 100% to win and the
shortcut called it 180%.”* The computation was fixed; the fixture was never regenerated.
`packages/ui/src/components/CoachPanel.tsx:646-649` then renders it unconditionally.

Reviewer A served it for real: `GET /lab/flop-spr-commitment` with the API down returns the
160 % string.

A product whose stated premise is *never being confidently wrong about probability* can display a
**160 % probability**. This violates the product's own guardrails §3 (“Never claim to be right”)
and §4 (“Never teach something false”).

**Fix:** regenerate the fixtures from the engine. Do not hand-edit — hand-editing is what produced
the drift.

### P0-2 — The Coach's action-legality guard fails open on 4 of its 5 surfaces
**Status: FAIL.** Reported by Reviewer A; mechanism confirmed directly by the lead auditor.

- `packages/poker-math/src/coach.ts:153` — `readonly legalActions?: readonly CoachAction[]` is
  **optional**.
- `packages/poker-math/src/coach.ts:556` — `input.legalActions === undefined || input.legalActions.includes(action)`.
  When the field is absent, **every action is treated as legal**. The guard **fails open**.
- `apps/api/src/workers/equity-worker.ts:105-120` — `CoachTask`, the wire type every non-live-table
  surface uses, **has no field for it** (only `minimumRaiseTo?`).
- Only `apps/api/src/ws/router.ts:653` (the live table) supplies it.

So the Scenario Lab, Hand Review, Legends compare and `POST /math/coach` all analyse with the
guard disabled. Measured by A: 3 shipped scenarios leave no opponent with chips behind, and **2
publish an illegal raise as the headline suggestion at `reasonable` confidence**, priced with 35 %
fold equity against a player who **cannot fold**.

This directly contradicts the codebase's own stated design principle (ADR 0003 — build the narrow
type field-by-field *so that it fails closed*). Here the analogous guard fails the other way.

Compounding it: `coach-legality.test.ts` **describes this exact bug in its header and passes**,
because it hands `legalActions` to `buildCoachReport` itself rather than driving the production
wire type.

### P1-1 — No dead-button rule; blinds are not charged correctly across a changing roster
**Status: PARTIAL (ENG-001).** Reviewer B.

`apps/api/src/rooms/table.ts:894-901` advances the **button** by one occupied seat and then derives
the blinds as button+1 / button+2 among whoever happens to be seated *now*. There is no dead-button
handling and no record of blind obligations.

Measured over 40 hands with a scripted join/leave schedule: **6 players paid the big blind twice in
a row and 1 skipped it entirely.** A player charged two consecutive big blinds pays `2×BB` where
the rules charge `BB + SB`.

Minimal repro: seats 0/1/3 six-max; hand 1 `BTN 1 / SB 3 / BB 0`; a player joins seat 2; hand 2
`BTN 2 / SB 3 / BB 0` — seat 0 pays again.

No chips are created or destroyed, so this is a fairness defect rather than an integrity one. **No
test in the repo varies the roster between hands** — B identifies this as the one genuine coverage
hole in the engine.

### P1-2 — No blind-posting obligation for newcomers
**Status: FAIL (ENG-023).** Reviewer B. Nothing tracks blind obligations, so a newcomer is dealt
straight in. Brute-forcing 15 seating combinations, **4 gave the newcomer a completely free hand,
twice on the button**. Standing up as the blinds approach and sitting back down afterwards is
unpunished.

### P1-3 — Two scenarios grade their own taught answer as not defensible
**Status: PARTIAL.** Reviewer C; corroborated independently by Reviewer A (PROD-026).

`rk-the-fold-that-feels-wrong` is titled “Folding top pair, top kicker”, asks *“call or fold?”*, and
its own reasoning concludes *“folding is better than calling”* — yet it resolves to
`supportedActions = {raise}`. A learner who folds is told their answer is **“not consistent with
this analysis”**, immediately followed by prose telling them to fold. `matched_expected` is written
`false` to the database. `eq-implied-odds-deep-stacks-turn` has the same defect.

Cause: the flat `DEFAULT_ASSUMED_FOLD_EQUITY = 0.35` feeds `bestEv` in `isDefensible`. **No test
asserts that a scenario's taught action is in its own defensible set**, and `validate.ts` checks
only `expectedInsight`, so the build stays green.

### P2 findings
- The Coach headlines `raise` in **30 of 36** scenarios, overriding lessons whose entire subject is
  that the price is wrong (C). A reports 26/36 by its own count.
- Button seat is not restored on room reopen after a restart, although `prl.hands.button_seat` **is**
  persisted (B).
- **Documentation overclaim:** `docs/REPORT.md:117` claims a *“20,000 hands / 167,987 decision
  points”* **engine** soak. The engine's soaks actually total **8,500** (4,000 + 1,500 + 3,000);
  the only `20_000` in the tree is a seed-collision check in `poker-ai` (B).

### P3 findings
- `ruleOf24`'s “count clean outs only” contradicts `totalOuts = clean + dirty` on the same panel.
- `combineMonteCarlo` drops the between-shard variance term (measured 0.0004 % — immaterial).
- The reported confidence interval is hero's only, and the summary does not say so.
- `describeScore` omits the deciding kicker for two pair and quads.
- No mucking — every live hand is revealed at showdown; `showdowns` are in seat order rather than
  showdown order; uncalled bets are reported as a one-player “pot” and “award”; `isAllInThisHand` is
  dead code with a wrong doc comment.

---

## 6. Conclusion

The pure core of this product — the rules engine and the mathematics — is **correct, and
demonstrably so under adversarial, independently-constructed testing**. The exhaustive 7-card
enumeration, the side-pot construction, the heads-up ordering, the incomplete-all-in reopening rule,
the unbiased shuffle, and every mathematical identity checked recompute correctly against
first-principles derivations.

The correctness failures that block release are **not in the computation**. They are in
**fixture data that has drifted away from the computation**, and in a **legality guard that fails
open** on every surface except the live table. Both are squarely release-blocking for a product
whose promise is that it will not be confidently wrong.
