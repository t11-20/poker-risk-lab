# Reviewer C — Poker Math (independent audit)

- **Auditor:** Reviewer C (Poker Math). Did not build this. Did not read `docs/audit/*.md` as evidence.
- **HEAD:** `f20bbad` (`f20bbad2f082e9fe135ce98070da16eff7cc3f14`)
- **Date:** 2026-08-19
- **Scope:** `packages/poker-math/src`, `packages/poker-engine/src/evaluate.ts`, Coach/UI probability rendering, shipped scenarios and numeric quizzes.
- **Not done:** no source edits; no `pnpm install`; no root build; no `db:reset`; no `docker compose down`.
- **Allowed runs:** `pnpm --filter @prl/poker-math test` (247/247 pass); `packages/poker-engine` `test/evaluate.test.ts` (15/15 pass); independent calculator at `/tmp/prl-audit-c/independent.mjs`; production comparison at `/tmp/prl-audit-c/compare-production.mjs`.

**Independence rule used:** every expected value in this report was produced by hand, by a closed form, or by `/tmp/prl-audit-c/independent.mjs`, which implements its own 7-card evaluator (rank-count arrays + tuples, not the production 13-bit lanes) and its own ICM (full permutation expansion, not the production bitmask `Q(S)`). Production was imported only *after* those expected values existed, to measure agreement.

---

## Verdict in one paragraph

The shipped poker maths is **correct on the figures a learner can be taught as facts**. Independent enumeration of AA vs KK over the three suit-isomorphism classes (≡ all 36 configs) gives **81.946050%** pot equity for AA, matching production bit-for-bit and the published ~81.9%. Wheel, kickers, best-5-of-7, ties-as-1/k, pot-odds identity `EV(call)=0` at break-even, raise-is-not-a-bet, required-fold-equity round-trip, Malmuth–Harville 3:1 / 70–30 → 60/40, and dirty/anti-out handling all independently check out. Coach EV is filtered to legal actions; impossible probabilities are refused at the producer and again at `CoachPanel`. Residual issues are **taxonomy / presentation**, not wrong equities: two SPR band systems on the same panel, no named anti-out bucket, no weighted ranges, and `requiredFoldEquity` is a bet formula even when the live action is a raise.

**No P0. No P1. Six P2. Four P3.**

---

## Requirement table

Nine fields per row: **ID**, **Requirement**, **Verdict**, **Independent recalculation**, **Implementation**, **Tests (circular?)**, **Learner-facing surface**, **Finding**, **Severity**.

| ID | Requirement | Verdict | Independent recalculation | Implementation | Tests (circular?) | Learner-facing surface | Finding | Severity |
|----|-------------|---------|---------------------------|----------------|-------------------|------------------------|---------|----------|
| MATH-001 | Hand evaluator: 9 categories, wheel (A2345 lowest straight), best-5-of-7, kickers, board-plays | **PASS** | Own evaluator: wheel packed as five-high (rank 3) and loses to 6-high; `Jh Qc Kd Ah 2s` is high-card (no wrap); steel wheel < royal; two trips in 7 → sevens full of fives; `Ah Kh 2h 7h 9h 2c 2d` is ace-high flush not trips; quads beat the boat; same five on two 7-card sets score equal (board plays). 4,000 random 7-card hands: **0 mismatches** vs best-of-C(7,5). | `packages/poker-engine/src/evaluate.ts`: 9 categories 0..8; `straightHigh` wheel branch returns 3; `packTop` kickers; 5–7 cards. | Engine `evaluate.test.ts` exhausts all 2,598,960 5-card hands against a *different* reference evaluator. Not self-equality. | `describeScore` names the wheel and royal flush in Coach/review. | None on ranking. | — |
| MATH-002 | Outs: clean / dirty / discounted / anti-outs | **PASS** (taxonomy PARTIAL) | Turn nut FD `Ah6h` / `Kh9h4s2c` vs `Kd9c`: **9 clean, 0 dirty, equity = 9/44**. Anti-SF: `AhKh` / `8h9h6c2d` vs `7h6h`: **5h and Th are not outs** (straight flush for villain); 11 clean. Dominated flush `Th9h` / `Ah7h2c4d` vs `QhJh`: remaining hearts **not outs**; 6 pair cards clean. Flop FD vs set `AhKh` / `2h7h3c` vs `3d3s`: **0 clean, 8 dirty**; `3h` (quads) excluded. | `outs.ts`: per-card exact equity; clean ≥ 0.90, dirty ≥ 0.50, else neutral. Already-ahead refuses the *word* “outs”. Anti-outs fall in **neutral**, not a fourth class. No numeric “half-out” discount — dirty are held out of the clean count. | `outs.test.ts` derives expected counts on paper (not by pasting the function). | Coach panel + Learn outs quizzes; dominated-flush scenario claims 9 *straight/pair* outs, not the flush cards. | Missing named anti-out bucket (see MATH-016). Discounting is the dirty split, which matches the quiz’s “discount and say why”, not a silent ×0.5. | P2 (taxonomy only) |
| MATH-003 | Exact equity enumeration | **PASS** | Independent combo enumerator: C(48,5) = **1,712,304** boards for preflop HU known hands; C(45,2) = 990 for the flop case. AA vs KK three classes and AhKh vs QsQd on `2h7h3c` enumerated independently. | `exactEquity` in `equity.ts`: legal matchups (blocker-aware) × remaining boards; ties award 1/k. Auto path enumerates when work ≤ 4e6. | Engine + math tests use paper counts and a second evaluator. No “function equals itself” for these figures. | Coach `method: exact-enumeration`, chip `=`. | Production matched independent equities **bit-for-bit** (see appendix). | — |
| MATH-004 | Monte Carlo equity + 95% CI is honest | **PASS** | Wald half-width 1.96 σ/√n. At p≈0.82, n=1e5 → ±0.24 pt; n=5e3 → ±1.06 pt. Independent coverage experiment: 80 MC runs × 3,000 trials of AhKh vs QsQd on `2h7h3c` (true equity 545/990) — **77/80 = 96.3%** of 95% intervals covered the independent exact value. Width tracks 1/√n. | `monteCarloEquity`: seeded, rejection-sampled legal matchups, partial Fisher–Yates run-out, Bessel-corrected sample sd of pot share, `halfWidth = 1.96 s / √n`. `samples < 2` or non-integer / Inf / NaN throw. Exact path reports `confidence: null`, not ±0. | Validation tests refuse NaN/Inf/1-sample certainty. Coverage was **this audit’s** experiment, not a repo test. | Coach shows `≈` + interval; sampled-without-bar is a warning callout. | n=2 is legal at the library (interval is then not a serious 95%). API/Coach operational sizes are thousands+. Combine-shards rebuilds σ from shard half-widths (fine at large n). | P3 (library min n=2) |
| MATH-005 | Ties credited as a fractional share | **PASS** | Board-plays: `2c3d` vs `4h5s` on `AhKhQhJhTh` — both play Broadway; independent equity **0.5**, tie rate **1**. AA vs KK AsAh vs KsKh: 9,308 chops / 1,712,304 → tie share 0.5436%; pot equity = win + tie/2 = 82.6366%. | `Tally.record`: `perWinner = 1/winners`; `equity = share/trials`. | Coach/outs/equity tests assert chops. Not circular for the board-plays case above. | Equity bar shows win and tie separately; pot share is the number used for EV. | None. | — |
| MATH-006 | Ranges: parse, expand, weight | **PARTIAL** | 169 classes = 13×6 + 78×4 + 78×12 = 1326. `A2s+` is fixed-high-card; `T9s+` is correctly ambiguous and must be rejected (connector vs low-card climb). Blockers remove combos. | `ranges.ts` parses, expands, dedupes, applies blockers. **`weight` is deliberately absent** (file header: unweighted sets only). `fractionOfAllHands` is notation mass / 1326, **not** post-blocker mass. | Parser tests exist; strength-table tests check combo-weighted cumulants. | Coach assumptions say every combo is equally likely. | Weighted ranges (e.g. “call 60% of ATo”) are not a surface. That is a documented design choice, not a silent 50/50 lie, but the catalog asked for weight. | P2 |
| MATH-007 | Pot odds and break-even equity; EV(call)=0 at break-even | **PASS** | Pot 100, toCall 50: BE = 50/150 = **1/3**, not 25%. `EV(call)= e·150 − 50`; at e=1/3 → **exactly 0**; at 25% → **−12.5**; at 50% → **+25**. A half-pot *bet* of 50 into 100 lays the *caller* 50/200 = 25% — a different question (`priceLaidByBet`). | `potOdds(pot, toCall)` excludes hero’s call; `oddsRatio` is `null` on a free check (not Inf/NaN). `evOfCall` uses `e(pot+toCall)−toCall`. | `odds.test.ts` / `ev.test.ts` re-derive BE by hand and cross-check modules. | Quiz `pot-odds-q2` is this exact 100/50 spot; live calc from `potOdds`. | The audit brief’s “BE 25%” is the common off-by-pot error. The product teaches 33.3% and is right. | — |
| MATH-008 | Call EV / check EV | **PASS** | `EV(check)=e·pot`; 25% of 100 = 25. `EV(fold)=0`. Check ≥ fold always; equality only at e=0 or pot=0. | `evOfCheck` delegates to `evOfCall(..., toCall:0)` and relabels terms. Coach ranks check above fold on a tie. | Hand-derived EV grid in `ev.test.ts`. | Coach candidates; Learn EV quiz: 0.4·(120+40)−40 = **+24**; 0.2·(80+40)−40 = **−16**. | `analyseScenario` sets `callEv=0` when `toCall===0` (it is not pricing a check). The one shipped `toCall: 0` scenario does not claim `callEvSign`. | P3 (scenario helper only) |
| MATH-009 | Fold equity and required fold equity round-trip | **PASS** | Pure bluff 50 into 100: f* = 50/150 = 1/3; `EV(bet)` at that f is ~0 (2e-15). Valued hand e=0.2: f* = 0.0909…; EV at f* ~0. When S≥0, f*=0. Identity `f* = −S/(pot−S)` with `S=e(pot+2b)−b`. | `requiredFoldEquity` + `evOfBet`; alpha from `defenceFrequency` (odds.ts), not a second copy of b/(pot+b). | Round-trip grid 257 losing-when-called bets; alpha cross-check vs odds.ts. Not self-equality. | Coach assumptions quote half-pot required FE. | **No raise-specific solver.** Coach still computes `requiredFoldEquity({pot, betSize: halfPot})` even when the candidate is a raise, so the “needs X% folds” sentence is a *bet* of half-pot, not the raise actually priced. The raise *EV* itself is correctly `evOfRaise`. | P2 |
| MATH-010 | Bet sizing EV (raise must not be priced as a bet) | **PASS** | Bet 50 into 100, f=0.35, e=0.4: EV = 54.5. Raise: pot=150 (includes the 50 faced), toCall=50, raiseBy=150, same f,e: risk=200, final pot=500, EV=52.5. Pricing that raise as `evOfBet(150, 150)` gives 72 — **overstatement 19.5 = (1−0.35)·50·(1−0.4)**. | Distinct `evOfBet` / `evOfRaise`. Coach: opening (`betLevel===0`) uses bet; else raise with `to = betLevel + raiseBy` and `cost = toCall+raiseBy`. Ladder rungs below the min raise are dropped. | `ev.test.ts` identity `EV(bet)−EV(raise)=(1−f)c(1−e)` over a grid. Coach legality tests ask the *engine* `validateAction`. | Candidate table states risk of a raise in the derivation. | Raise is not priced as a bet. | — |
| MATH-011 | Rule of 2 and 4 labelled approximation with actual error | **PASS** | 15 outs ×4 vs 47 unseen: exact 1−C(32,2)/C(47,2) = 585/1081 = **54.1166%** (caveat 54.1). 4 outs ×4: **16.466%** vs 16. 9 outs ×2 from 46: 9/46 = **19.565%** vs 18. 9 outs ×4: **34.968%** vs 36 (error +1.03 pt). 45×4 = 180% is not a probability. | `ruleOf24` refuses above 25 outs (×4) / 50 (×2). Coach `ruleOfThumbFor` uses **clean** outs only, publishes a **fraction**, compares to `probabilityOfHitting`, not to equity. | Caveat numbers are paper complements; `ruleOf24Accuracy` error sign/magnitude pinned. | Coach + quiz `rule24-q2/q3` ask for the shortcut (36 and 18), then a later question asks live equity. | None on the arithmetic. | — |
| MATH-012 | SPR, variance, risk of ruin, ICM (Malmuth–Harville) with stated assumptions | **PASS** (SPR labels PARTIAL) | ICM 2-player stacks 300/100, prizes 70/30: P1(A)=3/4 → **60 / 40** exactly. 3-handed 300/100/100, 70/30: **51 / 24.5 / 24.5**. 500/300/200, 50/30/20: A = 25+750/56 = **38.392857…** (permutation ICM). ROR: `exp(−2Bw/s²)`; no edge → 1. SPR after pot-bet at SPR 4: (4p−p)/(3p) = **1**. | `icm.ts` bitmask Malmuth–Harville, cap 9, assumptions always present. `variance.ts` A&S CDF + Acklam quantile; ROR diffusion formula. `stacks.ts` SPR bands: `<1, <3, <6, ≤13, >13`. | ICM tests use hand fractions and symmetry. Variance has CLT simulations against the closed form. | Learn variance / ROR calculations; Coach SPR tile. | **Two SPR taxonomies.** `stacks.ts` at SPR 3.5 is `"medium"`. `@prl/ui` `describeSpr(3.5)` is `"low"` (`<4`). CoachPanel prints the UI tile **and** the math explanation that names the other band. | P2 |
| MATH-013 | Content ↔ maths consistency for shipped scenarios and numeric quizzes | **PASS** | Independently checked: flush-draw scenario 9h8h / Kh5h2c vs KdQs → 9 clean hearts (pairs of 8/9 are not outs). Dominated flush 6d5d / Ad9d4c2s vs KdQd → diamonds are anti-outs; 3 sixes + 3 fives + 3 non-diamond threes = **9** genuine outs (matches `cleanOutsEquals: 9`). Quiz Th9h / Ah7h2c4d vs AsKs → **9** hearts; 5x is not a wheel (board is A-7-2-4-5). Pot-odds / EV quizzes match the closed forms. Numeric quiz answers are computed live (ADR 0006), not stored. | `scenario-analysis.ts` + `checkScenarioClaims`; Learn `learn-calculations.ts` is the only path to a quiz number. | `packages/content/test/scenarios.test.ts` “CLAIMS” suite recomputes every scenario. | Scenario Lab + Learn. | Qualitative claims are real verification; `equityBetween` etc. are regression locks (file says so). SPR band mismatch can still appear on the Coach next to a scenario. | P2 (SPR labels only) |
| MATH-014 | Impossible / undefined probabilities never rendered as real numbers | **PASS** (defence-in-depth; residual P3) | 45×4 = 180% is refused by `ruleOf24`. Free-call `oddsRatio` is `null` (JSON-safe). `assertProbabilityFraction` throws outside 0..1. | Producer refuses; `format.ts` **will** print `103.0%` if handed 1.03 (deliberately no clamp). `probability.ts` `formatProbability` returns `null` → Coach prints “not a probability”. | Coach report test: every fraction field and every sentence scanned for >100%. UI `probability.test.ts` + `coach-panel-render.test.ts`. | CoachPanel never imports `formatPercent`. Learn `figureValue` divides points back to a fraction before Metric. | Other surfaces (`PostHandComparison`, `ActionDistribution`, `LiveCalculation` EV-term table, legends) still call `formatPercent` unguarded. They currently receive 0..1 inputs. NaN/Inf render as “—”. | P3 |
| MATH-015 | Coach never claims exactness for sampled figures | **PASS** | — | `buildUncertainty`: exact → “no sampling error”; MC → trial count + ±half-width. Suggestion `whatWouldChangeIt` names the interval on MC. Chip `=` vs `≈`. | Coach tests: sampled reports carry an interval; exact reports `null` not 0. | CoachPanel warning if sampled and no usable bar. | `summariseCoachReport` writes ` (exact)` whenever `confidenceHalfWidthPoints === null`, **without** reading `method`. Production MC always sets the interval, so the live panel is safe; a log line could still say “exact” of a malformed sampled report. | P3 |
| MATH-016 | Anti-outs and dirty outs do not inflate equity | **PASS** | Equity is full run-out share, not outs×4. AhKh vs QsQd on 2h7h3c: hit-any-of-9-hearts = 34.97%, **true equity = 55.05%** (overcards + pair-outs), so using “9 outs” would *understate* here. FD vs set flop: 8 dirty hearts, 0 clean; 3h (quads) not an out. Dominated hearts excluded. Turn 9-clean FD: equity **equals** 9/44 (one card, every clean heart wins). | Outs never replace equity in EV. Rule-of-thumb uses clean only and is labelled. Already-ahead refuses to call 47 cards “outs”. | Outs tests + Coach “no probability above 100%” scan. | Panel heading uses `countsAsOuts(heroEquity)` independently of the report prose. | Anti-outs are **neutral**, so they do not enter `totalOuts`. No separate “anti” list for the learner (P2 under MATH-002). | — |
| MATH-017 | Published AA vs KK ~81.9% (all 36 suit configs) | **PASS** | Three isomorphism classes, C(48,5) each (independent evaluator): AsAh vs KsKh (2 shared suits) **82.636611%**; vs KsKd (1 shared) **81.946050%**; vs KdKc (0 shared) **81.255490%**. Weights per AA combo 1+4+1; uniform 36-config mean = (1·eq2+4·eq1+1·eq0)/6 = **81.946050%**. Spread 81.26–82.64%. Ties included as 1/2. | Production `exactEquity` on the same three matchups: **bit-identical** floats and 1,712,304 trials. | Repo has a loose API band (0.80–0.84), not a 36-config lock. **This audit** is the independent 36-config check. | Not a hardcoded lesson number (ADR 0006). | Matches the published ~81.9% figure. The one-shared-suit config *is* the 36-config average. | — |
| MATH-018 | Discounted outs vs exact equity on a known board | **PASS** | Turn `Ah6h` vs `Kd9c` on `Kh9h4s2c`: 9 clean, equity = 9/44 ≈ 20.455% = hit probability (one street, all clean hearts win). Flop FD vs set: dirty 8, clean 0; equity 0.2556 is the full two-card share, far below 8×4=32% if someone counted dirty as clean. Rule-of-4 vs hit-9-in-47: +1.03 pt; vs *equity vs QQ* the gap is a different quantity (overcards), and the Coach now compares the shortcut to hit probability, not to equity. | `ruleOfThumbFor` + `computeOuts` as above. | Outs tests state the 7/44 and 9/44 fractions in comments before asserting. | Coach teaching note: “hitting is not the same as winning”. | Consistent. | — |
| MATH-019 | Coach / grader: EV only for legal actions; illegal or unpayable lines are not taught as +EV | **PASS** | — | `buildCandidates` filters `input.legalActions ?? deriveLegalActions`. Empty list throws. Absent list is **not** “everything allowed”. `assertAffordable`. Grader: `requirePayableSizing` then `judgeConsistency`; unmatched size → `sizing-not-priced`; unmatched action → `action-not-priced`; `matched_expected` written NULL unless priced **and** single-defensible. Fold is not marked wrong on assumed fold equity. | `coach-legality.test.ts` (math): every shipped scenario’s Coach rows pass engine `validateAction`. API `coach-legality` / `x1-unpayable-sizing`. | Scenario Lab copy says “analysis did not price this”, not “you are wrong”. | `deriveLegalActions` is knowingly wider than the engine **only** for `mayRaise` (short all-in that does not reopen). Documented and tested. Live table passes the engine list. | P3 (`mayRaise` derivation) |

---

## Independent recalculation appendix

Script: `/tmp/prl-audit-c/independent.mjs` (own evaluator + enumerator + permutation ICM). Comparison: `/tmp/prl-audit-c/compare-production.mjs` (32/32 match).

### A. Evaluator self-check

| Check | Independent result |
|---|---|
| 9 categories, strictly ordered on textbook examples | hold |
| Wheel A2345 < 23456; wrap AJQK2 is not a straight | hold |
| Steel wheel < royal; both SF | hold |
| Kickers: AaKQj > AaKQt; suits ignored | hold |
| 7-card two trips → sevens full of fives | hold |
| 7-card flush over board trips | hold |
| Quads not scored as a boat | hold |
| Board plays: two 7-card sets sharing the same best five | equal scores |
| 4,000 random 7-card vs best-of-C(7,5) | **0 mismatches** |

Production `evaluate.test.ts` additionally matches a third algorithm on every 5-card hand (2,598,960). Not rerun exhaustively here (allowed suite is the non-exhaustive file); the 15 tests in that file passed.

### B. AA vs KK (MATH-017)

Independent 7-card eval, every remaining 5-card board, ties = ½.

| Matchup | Suits shared | Trials | Wins | Ties | Losses | Equity |
|---|---|---|---|---|---|---|
| AsAh vs KsKh | 2 | 1,712,304 | 1,410,336 | 9,308 | 292,660 | **0.826366112559452** |
| AsAh vs KsKd | 1 | 1,712,304 | 1,399,204 | 7,923 | 305,177 | **0.8194605046767397** |
| AsAh vs KdKc | 0 | 1,712,304 | 1,388,072 | 6,538 | 317,694 | **0.8125548967940273** |

36-config mean (weights 6 + 24 + 6): **0.8194605046767397 = 81.946050%**.
Published target ~81.9%. Delta +0.046 pt (rounding of the published figure).

Production `exactEquity` reproduced all three equities and the 1,712,304 trial count **bit-for-bit**.

### C. Flush-draw outs (MATH-002, MATH-016, MATH-018)

| Spot | Independent | Production |
|---|---|---|
| Ah6h / Kh9h4s2c vs Kd9c (turn) | 9 clean (`2h3h4h5h7h8hThJhQh`), eq=9/44 | same |
| AhKh / 8h9h6c2d vs 7h6h (turn, SF anti-outs) | 11 clean; **5h, Th neutral** | same |
| Th9h / Ah7h2c4d vs QhJh (dominated FD) | 6 pair outs; **0 hearts** | same |
| Th9h / Ah7h2c4d vs AsKs (quiz) | 9 hearts; 5c/5d/5s are *not* a wheel | same |
| AhKh / 2h7h3c vs 3d3s (flop FD vs set) | 0 clean, **8 dirty**, 3h excluded | same |
| AhKh / 2h7h3c vs QsQd (flop FD vs overpair) | eq = 545/990 = **0.550505…**; already-ahead so counts are not “outs” | same |

### D. Pot odds / EV / raise vs bet (MATH-007–010)

```
potOdds(100, 50)           = 1/3          (not 0.25)
EV(call, e=1/3)            = 0
EV(call, e=0.25)           = −12.5
EV(call, e=0.50)           = +25
EV(check, e=0.25, pot=100) = +25
EV(bet 50 into 100, f=0.35, e=0.4) = 54.5
EV(raise pot=150, c=50, r=150, f=0.35, e=0.4) = 52.5
misprice as bet(150,150)   = 72
overstatement              = 19.5 = (1−f)·c·(1−e)
required FE, e=0, 50 into 100 = 1/3; EV(bet) at that f ≈ 0
required FE, e=0.25, 50 into 100 = 0   (S=0 hinge)
```

Production matched every line.

### E. Rule of 2 and 4 error (MATH-011)

| Outs, streets | Shortcut | Independent exact | Caveat in `odds.ts` |
|---|---|---|---|
| 15, two, 47 unseen | 60% | 54.1166% | 54.1% |
| 4, two, 47 | 16% | 16.4662% | 16.5% |
| 9, one, 46 | 18% | 19.5652% | 19.6% |
| 15, one, 46 | 30% | 32.6087% | 32.6% |
| 9, two, 47 | 36% | 34.9676% | (derived in tests) |
| 45, two | 180% | refused | refused |

### F. ICM (MATH-012)

Independent **permutation** Malmuth–Harville:

- 2-way 300/100, 70/30 → **60 / 40** (catalog “60/40”; this is the 3:1 stack case).
- 3-way 300/100/100, 70/30 → **51 / 24.5 / 24.5** (true 3-handed 3:1:1).
- 3-way 500/300/200, 50/30/20 → **38.392857… / 32.75 / 28.857143…** matching the hand fractions in `icm.test.ts`.

Production `icmEquity` agrees (max residual 7e-15).

### G. Monte Carlo CI (MATH-004)

True equity 545/990. 80 independent production MC shards, n=3,000, distinct seeds. 77 intervals contained the true value (**96.3%**). Binomial Wald half-width at this p is ±1.78 pt; observed widths are the same order. Honest at operational n. Not honest as a 95% claim at n=2 (library minimum).

### H. Tests inspected for circularity

Not circular (expected values from paper / a second algorithm / identities):

- `packages/poker-engine/test/evaluate.test.ts` — reference evaluator, different algorithm.
- `packages/poker-math/test/ev.test.ts` — `breakEvenEquityByHand`, `evOfRaiseByHand`.
- `packages/poker-math/test/odds.test.ts` — urn counts and C(n,k) complements.
- `packages/poker-math/test/outs.test.ts` — card-by-card paper counts.
- `packages/poker-math/test/icm.test.ts` — hand fractions, symmetry.
- `packages/content/test/scenarios.test.ts` — claims vs live maths.

Mostly contractual / non-numeric: `equity.test.ts` (sampler validation only — **no AA vs KK lock in this package**).

---

## P0–P3 findings

### P0 — confidently wrong equity / outs / EV taught as fact; impossible probability shown as real

**None.** Independent recalculation did not find a wrong number on a learner-facing path. AA vs KK, outs (including anti-outs), pot odds, call/raise EV, ICM 60/40, and rule-of-2/4 error all agree with production. CoachPanel refuses non-probabilities.

### P1 — missing required math surface (no clean/dirty, no CI, raise priced as a bet)

**None** of the catalog examples. Clean/dirty exist; MC always carries a CI; raise uses `evOfRaise`.

### P2

1. **Two SPR band systems on the Coach.** `stackToPotRatio` (3.5 = “medium”) vs `describeSpr` (3.5 = “low”). `CoachPanel` renders both. Files: `packages/poker-math/src/stacks.ts` `bandOf`; `packages/ui/src/format.ts` `describeSpr`; `packages/ui/src/components/CoachPanel.tsx` `StackSection`.
2. **No named anti-out class.** Cards that *lose* the pot (dominated flush, SF for villain, 3h into a set) are `neutral`, mixed with blanks. Counts stay honest; the teaching split “blank vs anti-out” is only in prose. `packages/poker-math/src/outs.ts`.
3. **Ranges have no weights.** Catalog MATH-006 asked parse/expand/**weight**. Implementation is an unweighted set, stated as such. `packages/poker-math/src/ranges.ts`.
4. **`requiredFoldEquity` is a bet.** On a raise decision the Coach still quotes the fold frequency of a half-pot *bet*. Raise EV is correct; the fold-equity sentence is the wrong action. `packages/poker-math/src/coach.ts` ~1267–1284; `ev.ts` `requiredFoldEquity`.
5. **`OutsBreakdown` on the wire has no `refusal`.** The panel re-derives “are these outs?” from hero equity (`countsAsOuts`, bar 0.5). Safe today; a custom `aheadThreshold` or a stale fixture could desync heading vs producer. `coach.ts` `buildOutsBreakdown`; `packages/ui/src/outs-count.ts`.
6. **Content `callEv` is 0 on a free check.** `analyseScenario` does not use `evOfCheck`. No shipped claim currently depends on it.

### P3

1. `formatPercent` still prints values outside 0..100% by design; several non-Coach callers do not go through `formatProbability`.
2. Library Monte Carlo allows n=2 (Wald interval then meaningless). Operational floors are much higher.
3. `summariseCoachReport` labels a missing interval as “(exact)” without checking `method`.
4. `deriveLegalActions` can offer a raise the engine would withhold under `mayRaise`. Live table uses the engine list; Scenario Lab spots do not hit that case.

---

## Counts

| Score | IDs | n |
|---|---|---|
| **PASS** | MATH-001, 002, 003, 004, 005, 007, 008, 009, 010, 011, 012, 013, 014, 015, 016, 017, 018, 019 | **18** |
| **PARTIAL** | MATH-006 (parse/expand yes; weights absent by design) | **1** |
| **FAIL** | — | **0** |
| **P0** | — | **0** |
| **P1** | — | **0** |
| **P2** | SPR bands; unnamed anti-outs; no range weights; bet-only required FE; `OutsBreakdown` omits `refusal`; `callEv=0` on a free check | **6** |
| **P3** | unguarded `formatPercent`; MC n=2; `summariseCoachReport` “exact”; `mayRaise` derivation | **4** |

MATH-002 / 009 / 012 / 013 **pass on the numbers** and still carry a P2 presentation note. MATH-012’s ICM / ROR / variance closed forms independently matched; only the SPR *labels* conflict.

---

## Allowed test runs

```
pnpm --filter @prl/poker-math test     → 247 pass, 0 fail
packages/poker-engine test/evaluate.test.ts → 15 pass
  including exhaustive 2,598,960 5-card vs reference evaluator
```

Independent + compare scripts: `/tmp/prl-audit-c/independent.mjs`, `/tmp/prl-audit-c/compare-production.mjs`.
