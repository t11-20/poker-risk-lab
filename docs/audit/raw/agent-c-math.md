# Reviewer C — Poker math correctness

Independent release audit of `packages/poker-math`, `packages/poker-engine/src` (evaluator) and
`packages/content`.

**Method.** Every figure below was recomputed from first principles in throwaway probe scripts that
import the real modules. Where a reference implementation was needed I wrote my own — a naive
"score all C(n,5) subsets" hand evaluator, a brute-force heads-up board enumerator, and a
permutation-enumeration ICM — rather than trusting the repo's own tests, constants or reference
evaluator. Probe scripts live in
`/private/tmp/claude-501/-Users-terence-Projects-exploration-sites-poker-risk-lab/91a788e8-b6b0-4cba-addb-b14e826aac79/scratchpad/agentC/`
(`ref-eval.mjs`, `p1`–`p12`).

**Provenance note.** `packages/poker-math/src` imports `@prl/poker-engine`, which resolves to
`dist/`. Before testing anything I rebuilt both packages into my scratch dir with the repo's own
tsconfigs and diffed against the shipped `dist/` — byte-identical for every file, so `src` and the
runtime artefact are the same code. Command and result:

```
$ ./node_modules/.bin/tsc -p packages/poker-math/tsconfig.json --outDir $S/build-math ... ; \
  for f in $S/build-math/*.js; do diff -q "$f" "packages/poker-math/dist/$(basename $f)"; done
(no output — no differences)
$ ./node_modules/.bin/tsc -p packages/poker-engine/tsconfig.json --outDir $S/build-engine ... ; \
  for f in $S/build-engine/*.js; do diff -q "$f" "packages/poker-engine/dist/$(basename $f)"; done
(no output — no differences)
```

---

## Summary table

| ID | Area | Status |
|----|------|--------|
| MATH-001 | Hand evaluator — 9 categories, wheel, best-5-of-7, kickers, board-plays | PASS |
| MATH-002 | Outs counting, and the clean/dirty split | PASS |
| MATH-003 | Exact equity enumeration | PASS |
| MATH-004 | Monte Carlo and its 95% confidence interval | PASS |
| MATH-005 | Ties credited as a fractional share | PASS |
| MATH-006 | Pot odds and break-even equity (EV(call) = 0 identity) | PASS |
| MATH-007 | Call / check / bet / raise EV | PASS |
| MATH-008 | Bluff fold equity round-trip | PASS |
| MATH-009 | **Bet-size comparison — the raise-priced-as-a-bet P0** | **PASS (fix verified)** |
| MATH-010 | Rule of 2 and 4 labelled an approximation | PASS |
| MATH-011 | SPR, variance, risk of ruin, ICM (Malmuth–Harville) | PASS |
| MATH-012 | Content ↔ maths consistency for the 36 shipped scenarios and 24 numeric quizzes | PARTIAL |
| MATH-013 | Offline fixtures the web app renders when the API is down | **FAIL (P0)** |

**Counts:** PASS 11 · FAIL 1 · PARTIAL 1 · UNVERIFIED 0 · N/A 0

---

### MATH-001 Hand evaluator — correctness and ordering of all nine categories

- **Requirement (exact):** `evaluate()` must rank all nine hand categories correctly and compare
  within a category correctly, including: the wheel A-2-3-4-5 ranking below every other straight and
  below A-K-Q-J-T; the lowest straight flush beating the highest quads; counterfeited two pair;
  best-5-of-7 selection; every kicker position; and both players playing the board producing an exact
  tie.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/evaluate.ts:141-243` (`evaluate`),
  `:97-109` (`straightHigh`, including the wheel branch), `:111-121` (`pack`), `:123-133` (`packTop`),
  `:265-289` (`describeScore`), `:291-295` (`compareHands`).
- **Runtime evidence:** `node scratchpad/agentC/p1-evaluator.mjs`

```
=== 1. All nine categories, in ascending order (hand-built) ===
high card       2c 5d 9h Js Ad   code=high card   ref=high card   ok
pair            2c 2d 9h Js Ad   code=pair        ref=pair        ok
two pair        2c 2d 9h 9s Ad   code=two pair    ref=two pair    ok
three of a kind 2c 2d 2h 9s Ad   code=three of a kind ...         ok
straight (wheel)Ac 2d 3h 4s 5d   code=straight    ref=straight    ok  "straight, five high (the wheel)"
flush           2c 5c 9c Jc Kc   code=flush       ref=flush       ok
full house      2c 2d 2h 9s 9d   code=full house  ref=full house  ok
four of a kind  2c 2d 2h 2s 9d   code=four of a kind ...          ok
straight flush  Ac 2c 3c 4c 5c   code=straight flush ...          ok
  strictly ascending: true

=== 2. Wheel vs broadway ===
  wheel    = 4390912   six-high = 4456448   broadway = 4980736      (broadway > six-high > wheel)

=== 3. Wheel SF vs quads ===
  wheel SF = 8585216  six-high SF = 8650752  royal = 9175040  quad aces = 8171520
  (8585216 > 8171520: the LOWEST straight flush beats the HIGHEST quads)

=== 4. Best-5-of-7 ===
  9c8c7c6c2c 5d4h  -> flush (straight available but flush chosen)
  9c8c7c6c5c 2c Ad -> straight flush, nine high  (found inside a 6-card flush)
  KcKdKh 7c7d7h 2s -> "full house, kings full of sevens"  (two trips, higher trip plays)
  AcAd KcKd QcQd 2s-> two pair aces and kings; independent tuple [2,12,11,10] (queen kicker)

=== 5. Kicker comparisons ===
  AA K75 vs AA Q75 -> 1 ; AK975 vs AK974 -> 1 ; AA99K vs AA99Q -> 1 ;
  7777A vs 7777K -> 1 ; 555A2 vs 555A3 -> -1                    (all as hand-derived)

=== 6. Counterfeited two pair ===
  board 6c 5c 2s Kh Kd: hero 6d5d "two pair, kings and sixes" vs 7h7d "two pair, kings and sevens"
  cmp = -1 (hero loses)   independent reference: heroA=[2,11,4,3] villain=[2,11,5,4] cmp=-1

=== 7. Board plays ===
  royal on board          -> cmp 0
  quad aces + K on board  -> cmp 0, and a player holding a king is STILL a chop (cmp 0)
  A K Q J 9 on board      -> cmp 0 ; a player holding a ten makes a straight and wins (cmp 1)

=== 8. Randomised cross-check vs the independent reference (7-card) ===
  40000 random 7-card pairs: 0 ordering mismatches, 0 category mismatches
  category distribution (reference): high card=7182, pair=17424, two pair=9463,
    trips=1794, straight=1792, flush=1215, full house=1050, quads=76, straight flush=4
=== RESULT: ALL CHECKS PASSED ===
```

  The observed 7-card frequencies (17.96 / 43.56 / 23.66 / 4.49 / 4.48 / 3.04 / 2.63 / 0.19 / 0.010 %)
  track the known exact 7-card distribution (17.4 / 43.8 / 23.5 / 4.83 / 4.62 / 3.03 / 2.60 / 0.168 /
  0.0311 %) to sampling noise, which is an independent check that no category is being
  systematically mis-assigned.
- **Test covering it:** `packages/poker-engine/test/evaluate.test.ts`, plus
  `packages/poker-engine/test/exhaustive/seven-card-distribution.test.ts`.
- **Test result:** `packages/poker-engine`: 119 tests, 119 pass, 0 fail (I did not run the exhaustive
  suite; my own 40k randomised cross-check substitutes for it).
- **Reviewer notes:** My reference evaluator shares nothing with theirs except the card encoding —
  it enumerates all C(7,5)=21 five-card subsets and scores each with textbook rules. Zero
  disagreements over 80,000 hands. The two structurally risky cases (flush-and-full-house cannot
  co-occur in 7 cards; straight-flush-and-quads cannot co-occur) are provable and hold, so the
  early-return ordering in `evaluate` is safe.
- **Missing work:** none.

---

### MATH-002 Outs counting, and the CLEAN vs DIRTY split

- **Requirement (exact):** `computeOuts` must classify each card that can come next as clean
  (equity after ≥ 0.90), dirty (0.50 ≤ equity after < 0.90) or neutral, using the true post-card
  equity; a flush card that pairs the board and gives the opponent a full house must not be counted
  as an out.
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/outs.ts:688-792` (`computeOuts`),
  `:537-542` (`classify`), `:517-535` (`heroEquityOn`).
- **Runtime evidence:** `node scratchpad/agentC/p10-outs.mjs`. For every case the probe recomputes
  each candidate card's post-card equity with **my own** evaluator + enumerator and applies the
  documented thresholds itself, then compares card-by-card.

  Hand derivation for the headline case — hero `Ah Kh`, board `Qh 7h 2s 3d`, villain `Qs Qc`
  (set of queens), one card to come. Hearts left = 13 − Qh − 7h − Ah − Kh = 9:
  `2h` pairs the 2s and `3h` pairs the 3d, each giving QQQ a full house that beats the flush, so
  **7 outs, not 9**. Equity now = 7/44 = 15.909091 %.

```
### flush draw where two flush cards make the opponent a full house
    hero Ah Kh | board Qh 7h 2s 3d | villain Qs Qc (1 combos)
    equityNow  code 15.909091%   independent 15.909091%  (44 boards)
    counts     code 7 clean / 0 dirty / 37 neutral, 44 cards considered
    independent: 7 clean / 0 dirty / 37 neutral
    clean cards code: 4h 5h 6h 8h 9h Th Jh          <- exactly the seven I derived; 2h and 3h excluded

### clean nine-out flush draw on the turn
    hero 7h 5h | board Kh 9h 2s 3d | villain Ks Qd
    equityNow  code 20.454545%   independent 20.454545%      (= 9/44 exactly, as hand-derived)
    counts     code 9 clean / 0 dirty / 35 neutral

### flush draw against a range containing sets
    hero Ah Kh | board Qh 7h 2s | villain QQ,77,22,AQ,KQ,QJs,JJ,TT (42 combos)
    equityNow  code 44.369889%   independent 44.369889%  (41580 boards)
    counts     code 8 clean / 7 dirty / 32 neutral;  independent 8 clean / 7 dirty / 32 neutral
    clean: 3h 4h 5h 6h 8h 9h Th Jh      dirty: 2h Kc Kd Ac Ad Ks As
=== RESULT: ALL CHECKS PASSED ===
```

  Every card's `equityAfter` matched my independent enumeration to 1e-12 and every classification
  matched. Note `2h` correctly lands in *dirty* against the range (it completes the flush but fills
  up 22/77/QQ), and the naked overcards `A`/`K` are dirty rather than clean because the sets stay
  ahead — this is the product's headline feature working exactly as advertised.
- **Test covering it:** `packages/poker-math/test/outs.test.ts`.
- **Test result:** part of the 232-pass `@prl/poker-math` run below.
- **Reviewer notes:** The "opponent's two cards are not in the deck when the range has collapsed to
  one combination" adjustment is right and load-bearing — it is what makes the denominator 44 rather
  than 46, and my independent enumerator reproduces 9/44 = 20.4545 % rather than 9/46 = 19.5652 %.
- **Missing work:** none. (See P3-1 for a wording inconsistency between this module and `ruleOf24`.)

---

### MATH-003 Exact equity enumeration

- **Requirement (exact):** `exactEquity` must enumerate every legal board and produce the true
  pot-share; AA vs KK preflop ≈ 82 %, AKs vs QQ ≈ 46 %, and a nine-out draw's two-card completion
  must agree with 1 − (38/47)(37/46) ≈ 35.0 %.
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/equity.ts:385-458` (`exactEquity`),
  `:617-628` (`equity` method selection), `packages/poker-math/src/odds.ts:414-486`
  (`probabilityOfHitting`).
- **Runtime evidence:** `node scratchpad/agentC/p2-equity.mjs` — the "INDEPENDENT" rows are my own
  C(48,5) enumeration with my own evaluator (≈66 s per case; the code does it in 0.34 s).

```
--- AA vs KK preflop: As Ah vs Ks Kh ---
  INDEPENDENT: boards=1712304 win=1410336 tie=9308 lose=292660
               equity = (1410336 + 9308/2)/1712304 = 82.6366%
  CODE       : method=exact-enumeration trials=1712304 matchups=1
               win=82.3648% tie=0.5436% lose=17.0916% equity=82.6366%
  |delta| win=0.00e+0pts tie=0.00e+0pts equity=0.00e+0pts

--- AKs vs QQ preflop: As Ks vs Qh Qd ---
  INDEPENDENT: boards=1712304 win=787966 tie=6732 lose=917606  equity=46.2145%
  CODE       : win=46.0179% tie=0.3932% equity=46.2145%   |delta| = 0

--- Derivation check: 9 outs, two cards to come ---
  1 - (38/47)(37/46) = 1 - 0.650324 = 0.349676 = 34.97%
  probabilityOfHitting(9, 47, 2) = 34.9676%   (code)          -> match to 1e-12
  (the additive fallacy 9/47 + 9/46 = 38.7142% is explicitly NOT what the code does)
=== RESULT: ALL CHECKS PASSED ===
```

  Trial counts matched exactly (1,712,304 = C(48,5)) and equities matched to the last bit.
  AA-vs-KK depends on the suit configuration, and the code tracks that correctly:
  `AsAh vs KsKh` 82.6366 %, `AsAh vs KsKd` 81.9461 %, `AsAh vs KdKc` 81.2555 % — the brief's
  "~81.9–82.0 %" is the one-shared-suit case and the code reproduces it.
- **Test covering it:** `packages/poker-math/test/equity.test.ts`.
- **Test result:** part of the 232-pass run.
- **Reviewer notes:** `equity()` chose exact enumeration for every known-hand spot I fed it and
  reported `method: 'exact-enumeration'` with `confidence: null` (not a fabricated ±0.00).
- **Missing work:** none.

---

### MATH-004 Monte Carlo, and whether the confidence interval is computed correctly

- **Requirement (exact):** the sampled result must agree with exact enumeration inside its stated
  interval; the interval must be a correct 95 % normal-approximation half-width (right z, right
  denominator, ties accounted for).
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/equity.ts:568-615` (`monteCarloEquity`;
  `halfWidth = 1.96 * stdDev / sqrt(n)` at `:600-601`), `:265-272` (`firstPlayerStdDev`, with the
  Bessel correction), `:646-700` (`combineMonteCarlo`).
- **Runtime evidence:** `node scratchpad/agentC/p3-mc-ties.mjs`. I derived the half-width myself from
  the reported win/tie fractions: per-trial pot share X ∈ {0, ½, 1}, so E[X] = win + tie/2 and
  E[X²] = win + tie/4; s = √( (E[X²] − mean²) · n/(n−1) ); half-width = 1.96·s/√n.

```
  exact truth (hero equity) = 0.826366112559452
  n=  1000 equity=0.822000  hand-derived s=0.381394  half-width=2.3639 pts
           code reports level=0.95 halfWidthPoints=2.3639 samples=1000
           interval [79.8361%, 84.5639%] contains truth 82.6366%? true
  n= 10000 hand-derived half-width=0.7430 pts   code 0.7430   contains truth? true
  n=100000 hand-derived half-width=0.2333 pts   code 0.2333   contains truth? true
  coverage: 191/200 = 95.5% of 95% intervals contain the exact value (mean |err| 0.658 pts)
  determinism (same seed): true
  MC on a guaranteed chop: equity=0.5 tie=1 halfWidth=0 pts
  4x25k shards combined: equity=0.824860 halfWidth=0.2344 pts;  pooled-sample hand check 0.2344
    relative difference: 0.0004%; combined interval contains the exact value
  samples=0 / 1 / 1.5 / NaN / Infinity / 5000001  -> EquityError in every case
=== RESULT: ALL CHECKS PASSED ===
```

- **Test covering it:** `packages/poker-math/test/equity.test.ts`.
- **Test result:** part of the 232-pass run.
- **Reviewer notes:** The half-width is on the *pot share* (not the win rate), so ties are inside the
  variance rather than being dropped — that is the correct construction and it matched my derivation
  to 1e-12 at three sample sizes. z = 1.96 is the right two-sided 95 % multiplier and the value is
  documented and returned as a **half**-width, which is what the field name says. 200-run coverage of
  95.5 % is exactly what a correct 95 % interval should give. The one nit is in `combineMonteCarlo`
  (P3-2): it pools only the within-shard variance and weights by `n` rather than `n−1`, so the pooled
  interval is very slightly optimistic — measured at 0.0004 % of its own width, i.e. immaterial.
- **Missing work:** none blocking.

---

### MATH-005 Ties must be credited as a fractional share

- **Requirement (exact):** a board where k players hold the best hand must award each 1/k, both in
  exact enumeration and in Monte Carlo.
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/equity.ts:237-262` (`Tally.record`, the
  `perWinner = 1/winners` share).
- **Runtime evidence:** `node scratchpad/agentC/p3-mc-ties.mjs`

```
  royal on board: hero win=0 tie=1 lose=0 equity=0.5 ; villain identical ; sum = 1
  hero royal flush vs 22 on Ah Kh Qh Jh 3s: equity = 1 exactly
  3-way royal board: a=0.333333 b=0.333333 c=0.333333   (|err| < 1e-12 from 1/3)
  AA vs KK: win=82.3648% tie=0.5436% equity=82.6366%
            equity - win = 0.271798 pts ;  tie/2 = 0.271798 pts     (identity holds to 1e-12)
            heads-up equities sum to 1 ; tie fractions equal for both players
  MC on a guaranteed chop: equity=0.5, tie=1, halfWidth=0 pts
```

- **Test covering it:** `packages/poker-math/test/equity.test.ts`.
- **Test result:** part of the 232-pass run.
- **Reviewer notes:** The common failure modes (ties counted as wins, ties dropped, ties counted for
  only one player) are all excluded by the three-way and heads-up checks above. `Tally.record`'s
  `best = -1` seed is safe because every `HandScore` is ≥ 0.
- **Missing work:** none.

---

### MATH-006 Pot odds and break-even equity — the EV(call) = 0 identity

- **Requirement (exact):** `potOdds(pot, toCall).breakEvenEquity` must equal `toCall/(pot+toCall)`,
  and `evOfCall` at exactly that equity must be zero, at several pot/bet sizes. A bet of `b` into `p`
  must lay the caller `b/(p+2b)`.
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/odds.ts:197-225` (`potOdds`),
  `:710-732` (`priceLaidByBet`, implemented by delegating to `potOdds` with a middle that already
  contains the bet), `:663-708` (`defenceFrequency`).
- **Runtime evidence:** `node scratchpad/agentC/p4-odds-ev.mjs`

```
  pot=   100 toCall=   50 | code BE=0.333333333333 hand BE=0.333333333333 | ratio 2   | EV(call) at BE = 0.000e+0
  pot=   100 toCall=  100 | code BE=0.500000000000 hand BE=0.500000000000 | ratio 1   | EV(call) at BE = 0.000e+0
  pot=   100 toCall=   25 | code BE=0.200000000000 hand BE=0.200000000000 | ratio 4   | EV(call) at BE = 0.000e+0
  pot=    60 toCall=   20 | code BE=0.250000000000 hand BE=0.250000000000 | ratio 3   | EV(call) at BE = 0.000e+0
  pot=     3 toCall=    7 | code BE=0.700000000000 hand BE=0.700000000000 | ratio 0.42857 | EV(call) at BE = 0
  pot= 12345 toCall= 6789 | code BE=0.354813421135 hand BE=0.354813421135 | ratio 1.81838 | EV(call) at BE = 0
  pot=   100 toCall=    0 | code BE=0.000000000000 | ratio null (not Infinity/NaN)      | EV(call) = 0

  anchor pot-sized: ratio=2 BE=33.3333%   anchor half-pot: ratio=3 BE=25.0000%
  defenceFrequency(100,100): alpha=0.5 mdf=0.5 sum=1 ; defenceFrequency(100,50): alpha=1/3
```

  EV(call) at the break-even equity is **exactly** 0.000e+0 at every size tested — not "close to".
- **Test covering it:** `packages/poker-math/test/odds.test.ts`, `test/ev.test.ts`.
- **Test result:** part of the 232-pass run.
- **Reviewer notes:** The `b/(p+2b)` vs `b/(p+b)` confusion — the single most common error in poker
  writing about this — is structurally impossible here because `priceLaidByBet` delegates to
  `potOdds`, and `alpha` is a separate function with its own doc warning. Both anchors check out.
- **Missing work:** none.

---

### MATH-007 Call / check / bet / raise EV recomputed by hand

- **Requirement (exact):** each EV function must implement its stated closed form, terms must sum to
  the EV, and term probabilities must sum to 1.
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/ev.ts:186` (`evOfFold`), `:222` (`evOfCall`),
  `:284` (`evOfCheck`), `:429` (`evOfBet`), `:491` (`evOfRaise`), `:700` (`evOfSemiBluff`).
- **Runtime evidence:** `node scratchpad/agentC/p4-odds-ev.mjs`

```
  EV(call) pot=100 toCall=50 e=0.4000 -> code 10.000000000, hand 0.4*150-50 = 10
  EV(call) pot=100 toCall=50 e=0.3333 -> code  0.000000000, hand 0
  EV(call) pot=40  toCall=60 e=0.5500 -> code -5.000000000, hand 0.55*100-60 = -5
  EV(check) pot=250 e=0.61 -> 152.5 (hand 0.61*250)      EV(fold) = 0
  EV(bet) p=100 b=75 f=0.4 e=0.3 -> code 40, hand 0.4*100 + 0.6*[0.3*250-75] = 40
     f=1 -> 100 (= pot exactly);  f=0 -> 0 (= the called branch exactly)
  EV(raise) p=150 c=50 r=150 f=0.45 e=0.25 -> code 26.25, hand 0.45*150 + 0.55*(0.25*500-200) = 26.25
     risk code 200 = c+r ; terms sum to ev ; c=0 reproduces evOfBet exactly (46.875 both)
  semi-bluff p=100 b=60 f=0.4 e=0.3: ev=43.6 = hand; foldShare 40 + showdownShare 3.6 = 43.6
```

- **Test covering it:** `packages/poker-math/test/ev.test.ts`.
- **Test result:** part of the 232-pass run.
- **Reviewer notes:** The zero-point convention (folding = 0, sunk chips excluded) is applied
  consistently, and `evOfCheck` returns `e × pot` rather than a hard-coded 0 — the specific defect
  that used to let a fold outrank a free check. Verified at runtime: a stone-dead hand facing no bet
  still prices `check` above `fold` (2.273 vs 0.000 in a probe where the true chop chance is 2/44).
- **Missing work:** none.

---

### MATH-008 Required fold equity must round-trip back to EV(bet) = 0

- **Requirement (exact):** `requiredFoldEquity(...).foldEquityNeeded = f*` must satisfy
  `evOfBet(pot, b, f*, e).ev = 0`; at `e = 0` it must equal alpha `b/(pot+b)`; at
  `e = b/(pot+2b)` it must be 0.
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/ev.ts:623-698` (`requiredFoldEquity`),
  `:748-770` (`breakEvenBluffFrequency`, which reads alpha from `defenceFrequency` in `odds.ts`).
- **Runtime evidence:** `node scratchpad/agentC/p4-odds-ev.mjs`

```
  p=100 b= 50 e=0   : S=-50.00 code f*=0.333333333 hand f*=0.333333333 -> EV(bet at f*) = -7.105e-15
  p=100 b= 50 e=0.2 : S=-10.00 code f*=0.090909091 hand f*=0.090909091 -> EV(bet at f*) =  1.776e-15
  p=100 b=100 e=0.15: S=-55.00 code f*=0.354838710 hand f*=0.354838710 -> EV(bet at f*) =  0.000e+0
  p=200 b= 30 e=0.05: S=-17.00 code f*=0.078341014 hand f*=0.078341014 -> EV(bet at f*) = -1.776e-15
  p= 60 b= 45 e=0.35: S= +7.50 code f*=0            (needs no fold equity — correct, S >= 0)

  pure bluff p=100 b= 50: requiredFoldEquity=0.333333333333 = breakEvenBluffFrequency = 50/150
  pure bluff p=100 b=100: 0.500000000000 = 100/200
  pure bluff p= 75 b=150: 0.666666666667 = 150/225
  e = b/(p+2b) = 0.25   : requiredFoldEquity = 0 exactly
```

  Round-trip residuals are at the 1e-15 floating-point floor, i.e. exact.
- **Test covering it:** `packages/poker-math/test/ev.test.ts`.
- **Test result:** part of the 232-pass run.
- **Reviewer notes:** Two independently derived quantities (the f-intercept of the EV line, and
  alpha computed from the price) agree to 1e-12 — a genuine cross-check, since neither is computed
  from the other. The `S ≥ 0` branch returning 0 rather than a negative fraction is correct.
- **Missing work:** none.

---

### MATH-009 Bet-size comparison — RE-VERIFICATION of the raise-priced-as-a-bet P0

- **Requirement (exact):** when hero faces a bet of `c` and raises by `r`, the Coach must price the
  action with `EV(raise) = f·pot + (1−f)·[e·(pot + c + 2r) − (c + r)]`, **not** with the opening-bet
  formula `f·pot + (1−f)·[e·(pot + 2r) − r]`, which overstates by exactly `(1−f)·c·(1−e)`.
- **Status:** **PASS — the fix is real, verified against my own derivation, not against their tests.**
- **Implementation location:** `packages/poker-math/src/coach.ts:604-676` (`buildCandidates`
  aggressive block): `:633` uses `evOfBet` **only** when `betLevel === 0` (a genuine opening bet),
  `:652` uses `evOfRaise` otherwise; `to` is `betLevel + raiseBy` at `:662` and `cost` is
  `raise.risk` = `toCall + raiseBy` at `:663`. `packages/poker-math/src/ev.ts:491-559` (`evOfRaise`).
- **Runtime evidence:** `node scratchpad/agentC/p6-coach-raise.mjs`. For every candidate the probe
  recomputes the EV with formulas written out in the probe itself, and *also* computes what the old
  bug would have produced.

```
### flush draw vs a set, facing a half-pot flop bet   (pot=150 toCall=50 stack=500 bb=10, e=25.5556%, f=0.35)
    fold           cost=    0  code EV=     0.0000  hand EV=     0.0000  MATCH
    call to 50     cost=   50  code EV=     1.1111  hand EV=     1.1111  MATCH   [e*(pot+c)-c]
    raise to 100   cost=  100  code EV=    37.3333  hand EV=    37.3333  MATCH   [f*pot+(1-f)[e(pot+c+2r)-(c+r)] r=50]
        if priced as an opening BET (the old bug): 61.5278 -> overstatement 24.1944; (1-f)*c*(1-e) = 24.1944
    raise to 183   cost=  183  code EV=    10.9578  hand EV=    10.9578  MATCH
    raise to 500   cost=  500  code EV=   -89.7778  hand EV=   -89.7778  MATCH

### weak hand facing a big bet (the low-equity case the bug hurt most)  e=0.6061%, f=0.4, c=200
    raise to 400   code EV=  -157.0909  hand EV=  -157.0909  MATCH
        old bug: -37.8182  -> overstatement 119.2727 ; (1-f)*c*(1-e) = 119.2727

### river bluff-catcher facing a big bet   e=19.5122%, f=0.45, c=540
    raise to 1260  code EV=    21.0732  hand EV=    21.0732  MATCH
        old bug: 260.1220  -> overstatement 239.0488 ; (1-f)*c*(1-e) = 239.0488

### preflop, hero is the small blind (committed=10, toCall=30)
    raise to 70    cost=   60  code EV=    32.2629  hand EV=    32.2629  MATCH   [r=30, to = 10+30+30]
    (cost = toCall + raiseBy and to = heroCommittedThisStreet + toCall + raiseBy on every raise row)

### nothing to call (opening bet, NOT a raise)   toCall=0
    bet to 37 / 100 / 500 all priced with f*pot+(1-f)[e(pot+2b)-b]  -> MATCH
=== RESULT: ALL CHECKS PASSED ===
```

  Then over the **36 shipped scenarios** (`node scratchpad/agentC/p7-scenarios.mjs`):

```
  scenarios analysed          : 36
  candidate EV mismatches     : 0        (every candidate recomputed independently)
  coach suggestion != my rank : 0
  recommendations the OLD raise-as-bet bug would have flipped: 5
     fl-top-pair-weak-kicker-river:  correct=fold  buggy=raise@91
     fl-same-cards-under-the-gun:    correct=fold  buggy=raise@22
     fl-gutshot-facing-turn-bet:     correct=fold  buggy=raise@131
     fl-overcards-dirty-outs:        correct=fold  buggy=raise@85
     eq-flush-draw-turn-overbet:     correct=fold  buggy=raise@500
```

- **Test covering it:** `packages/poker-math/test/coach.test.ts`,
  `packages/poker-math/test/coach-legality.test.ts`.
- **Test result:** `@prl/poker-math`: 232 tests, 232 pass, 0 fail.
- **Reviewer notes:** This is the item I was told to treat as highest priority and it genuinely
  passes. Three separate confirmations: (a) every raise EV matches a formula I wrote out myself;
  (b) the delta from the bet formula is exactly `(1−f)·c·(1−e)` in all 20+ raise rows I checked, to
  1e-9, which is the signature of the specific bug; (c) five of the 36 shipped scenarios flip from
  `fold` to `raise` under the old formula and now correctly read `fold` — consistent with the
  previously reported "6 of 35" (the bundle now has 36 scenarios and the boundary case count moved by
  one). `to` and `cost` are also correct, including the preflop small-blind case where
  `heroCommittedThisStreet > 0`.
- **Missing work:** none. **But see MATH-013** — the *fixtures the web app ships* were regenerated
  for the raise fix but not for two later fixes, so the pre-fix figures still exist in the product in
  a different form.

---

### MATH-010 Rule of 2 and 4 must be labelled an approximation

- **Requirement (exact):** wherever the shortcut is taught or shown, it must be presented as an
  approximation with the direction and size of its error, and it must never emit a value above 100 %.
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/odds.ts:280-330` (`ruleOf24`, with the
  `maximumOutsForRuleOf24` refusal), `:348-388` (`ruleOf24Accuracy`),
  `packages/poker-math/src/coach.ts:320-345` (`buildRuleOfThumb`), `:365-374` (`ruleOfThumbFor`,
  the single gate both the Coach and `@prl/content` go through),
  `packages/content/data/glossary.json` entry `rule-of-2-and-4`.
- **Runtime evidence:** `node scratchpad/agentC/p4-odds-ev.mjs`

```
   9 outs, 2 to come: shortcut 36% | code exact 34.9676% | hand exact 34.9676% | error  1.0324 pts
   9 outs, 1 to come: shortcut 18% | code exact 19.5652% | hand exact 19.5652% | error -1.5652 pts
  15 outs, 2 to come: shortcut 60% | code exact 54.1166% | hand exact 54.1166% | error  5.8834 pts
   4 outs, 2 to come: shortcut 16% | code exact 16.4662% | hand exact 16.4662% | error -0.4662 pts
  12 outs, 1 to come: shortcut 24% | code exact 26.0870% | hand exact 26.0870% | error -2.0870 pts
  ceiling: 2 cards -> 25, 1 card -> 50
  ruleOf24(26, 2) -> OddsError ; ruleOf24(51, 1) -> OddsError ; ruleOf24(47, 2) -> OddsError
```

  I also verified the *hard-coded caveat strings* in `ruleOf24`, which are the one place a wrong
  constant could be shipped: "at 15 outs ×4 says 60% where the exact figure with 47 cards unseen is
  54.1%, an overstatement of 5.9 points" — 1 − (32/47)(31/46) = 54.1166 %, overstatement 5.8834 ✓;
  "at 4 outs it slightly understates (16% against 16.5%)" ✓; "9 outs is 19.6%, not 18%" = 9/46 ✓;
  "15 outs is 32.6%" = 15/46 ✓; "one card off a 46-card stub is worth about 2.17%" = 1/46 ✓.
  Glossary: *"A table-friendly approximation… It is deliberately rough."* Lesson text: *"the most
  useful approximation in poker and also the one most often used past the point where it is honest."*
- **Test covering it:** `packages/poker-math/test/odds.test.ts`, `packages/content/test/scenarios.test.ts`.
- **Test result:** part of the 232-pass run; `@prl/content` 13 tests, 13 pass.
- **Reviewer notes:** The live path is right. The *fixture* path is not — see MATH-013, where a
  shipped panel prints "the rule of 2 and 4 gives 160% here".
- **Missing work:** none in the live code.

---

### MATH-011 SPR, variance, risk of ruin, ICM (Malmuth–Harville)

- **Requirement (exact):** ICM must implement Malmuth–Harville correctly (specifically: two players
  with 3:1 stacks and 70/30 payouts must be 60/40); SPR, the sizing ladder, the normal CDF/quantile,
  win-rate projection, risk of ruin and the downswing table must all match hand derivations.
- **Status:** PASS
- **Implementation location:** `packages/poker-math/src/icm.ts:154-220` (`malmuthHarville`),
  `packages/poker-math/src/stacks.ts:114-142` (`effectiveStack`), `:193-212` (`stackToPotRatio`),
  `:300-330` (`sizingLadder`), `:355-397` (`commitmentThreshold`),
  `packages/poker-math/src/variance.ts:110-115` (`normalCdf`), `:166-190` (`normalQuantile`),
  `:390-435` (`projectResults`), `:620-694` (`riskOfRuin`), `:707-...` (`bankrollForRiskTolerance`).
- **Runtime evidence:** `node scratchpad/agentC/p9-icm-variance.mjs`. The "independent" ICM rows come
  from my own enumeration of every finishing permutation with
  `P(order) = Π_k s_{π(k)} / (chips remaining before step k)`.

```
  2 players, 3:1 stacks, 70/30    independent : 60.000000, 40.000000
                                  code        : 60.000000, 40.000000
  Hand derivation:  P(A first) = 7500/10000 = 0.75 ; P(A second) = 0.25
                    EV(A) = 0.75*70 + 0.25*30 = 52.5 + 7.5 = 60
                    EV(B) = 0.25*70 + 0.75*30 = 17.5 + 22.5 = 40   -> 60/40 IS correct
  3 players 5000/3000/2000, 50/30/20  independent 38.392857, 32.750000, 28.857143 = code
  4 players (bubble) 4000/3000/2000/1000, 50/30/20
                                  independent 33.603175, 29.488095, 23.587302, 13.321429 = code
  5 players winner-take-all       ICM == chip share exactly (correct: a flat ladder is linear)
  concavity: leader ICM 38.3929 < chip share 50.0000 ; short stack 28.8571 > 20.0000

  stackToPotRatio(300,100).spr = 3 ; (455,130) = 3.5 ; commitmentThreshold(400,100) = 1
  sizingLadder(100,1000): every rung's priceLaidToCaller = amount/(100+2*amount) and
    minimumDefenceFrequency = 100/(100+amount), to 1e-12
  mRatio(1000, sb10, bb20, ante0, 9) = 33.3333 = 1000/30

  Phi(1)=0.8413447404 (published 0.8413447461, |err| 5.7e-9) ; Phi(1.96) |err| 7.0e-8
  z(0.975)=1.959963986 (published 1.959963985) ; z(0.99)=2.326347874 exact to 3.9e-10

  100k hands @5bb/100 sd100: mean 5000 = 5*1000 ; sd 3162.2777 = 100*sqrt(1000)
    P(loss) 0.05692315 = Phi((0-5000)/3162.28) ; 95% interval [-1198.06, 11198.06]
  riskOfRuin(B=1000, w=5, sd=100) = 0.367879441 = exp(-2*1000*5/100^2) = exp(-1)
    zero edge -> 1 ; negative edge -> 1 (correct: a driftless walk is recurrent)
  bankroll for 5% RoR = 2995.7323 = sd^2*ln(1/0.05)/(2w) ; round-trips to 0.050000000
  P(finish >= 1000bb down) = 0.02888972 = Phi((-1000-5000)/3162.28)
  handsNeededForPrecision(sd 100, ±1bb/100) = 3841459 = 100*(z*sd/1)^2
=== RESULT: ALL CHECKS PASSED ===
```

- **Test covering it:** `packages/poker-math/test/icm.test.ts`, `test/variance.test.ts`, `test/stacks.test.ts`.
- **Test result:** part of the 232-pass run (which includes three simulation tests that check the
  normal model against sampled runs).
- **Reviewer notes:** The brief asked me to derive independently whether 60/40 is actually correct
  for 3:1 with 70/30 — **it is**, both by the two-line hand derivation above and by full permutation
  enumeration. The subset-DP in `malmuthHarville` is an exact reformulation of the permutation sum,
  and it matched my enumeration to 1e-9 in all six configurations including a bubble where fourth
  place pays nothing. The risk-of-ruin exponential is the standard Brownian-with-drift absorbing
  barrier result, the units cancel as claimed, and the assumptions list is honest about the
  approximation.
- **Missing work:** none.

---

### MATH-012 Content ↔ maths consistency for the shipped scenarios and quizzes

- **Requirement (exact):** no content may hard-code a computed number; every shipped scenario's
  stated teaching point must still be true against the code's own computed figures; every numeric
  quiz answer must be the value the maths produces.
- **Status:** **PARTIAL**
- **Implementation location:** `packages/content/src/scenario-analysis.ts:147-215`
  (`analyseScenario`), `:241-330` (`checkScenarioClaims`), `:76-135` (`readSituation`),
  `packages/content/data/scenarios/*.json` (36 scenarios),
  `packages/content/data/quizzes.json` (24 numeric questions),
  `apps/api/src/routes/content.ts:607-625` (`closedFormTable`),
  `packages/poker-math/src/consistency.ts:108-116` (`isDefensible`), `:185-230` (`judgeConsistency`).

**What passes.**

No percentage literal appears anywhere in the lesson, glossary or quiz prose (0 matches for both
`\d+%` and "N per cent" across all four content files); the lessons carry 35 live `calculation`
blocks instead. Both consumers of those blocks — `apps/api/src/routes/content.ts` and
`apps/web/src/lib/learn-calculations.ts` — call the same `@prl/poker-math` functions, so there is no
second implementation to drift.

All 36 scenarios and all 24 numeric quiz answers were recomputed
(`node scratchpad/agentC/p7-scenarios.mjs`, `p11-quiz.mjs`):

```
  scenarios analysed          : 36
  candidate EV mismatches     : 0
  coach suggestion != my rank : 0
  failed teaching claims      : 0     (all equityExceedsBreakEven / breakEvenExceedsEquity /
                                       callEvSign / cleanOutsEquals claims hold)

  every numeric quiz answer, code vs hand — 24 of 24 MATCH, e.g.
  betting-actions-q4  oddsRatio        code   3.0000  hand   3.0000  [60/20]
  blinds-q4           breakEvenEquity  code  30.7692  hand  30.7692  [4/(9+4)]
  ev-q1               ev               code  24.0000  hand  24.0000  [0.4*(120+40)-40]
  fold-equity-q2      ev               code  55.0000  hand  55.0000  [0.5*100+0.5*(0.3*200-50)]
  variance-q2         probabilityOfLoss code 30.8538  hand  30.8538  [Phi((0-500)/1000)]
  ror-q3              probability      code  10.8368  hand  10.8368  [exp(-2*3000*3/90^2)]
  reading-board-q4    heroEquity       code  53.4343  independent 53.4343   (my own enumeration)
  rule24-q5           heroEquity       code  38.8889  independent 38.8889
  ranges-q5           heroEquity       code  74.4444  independent 74.4444
```

**What fails.**

The app's own grading rule (`judgeConsistency` → `isDefensible`) marks a fold consistent only when
`bestEv <= oneBigBlind`. Because the Coach applies a flat `DEFAULT_ASSUMED_FOLD_EQUITY = 0.35`
(`packages/poker-math/src/coach.ts:165`) to every spot regardless of the range the same report has
just enumerated, an all-in raise usually prices above that margin — so in some scenarios **the
action the scenario teaches is graded as not defensible**.

`node scratchpad/agentC/p8-consistency.mjs`, judging every action exactly as the API does:

```
id                                     bb teaches coach  fold?  call?  raise?  bestEV margin supported
eq-implied-odds-deep-stacks-turn       10 FOLD    raise  false  false  true      18.3     10  raise   <=== CONTRADICTS
rk-the-fold-that-feels-wrong           20 FOLD    raise  false  false  true     126.5     20  raise   <=== CONTRADICTS

rk-the-fold-that-feels-wrong  "Folding top pair, top kicker"
  question: Should hero call or fold the big river bet?
  reasoning: "...against the range described the price asks for more than your share of the pot,
              so folding is better than calling."
  computed : equity 16.7%, needs 30.8%, call EV -183.3   -> the scenario's own claims all PASS
  graded   : fold NOT defensible, call NOT defensible, only "raise to 560" is.
             Coach headline = raise (+126.5 chips at an assumed 35% fold rate)

eq-implied-odds-deep-stacks-turn  "Implied Odds With Deep Stacks"
  question: Should hero call or fold?
  computed : equity 22.2%, needs 32.4%, call EV -38.0
  graded   : fold NOT defensible (best EV 18.3 > margin 10), call NOT defensible; only raise is.
```

A learner who answers the question the scenario asks, with the answer the scenario's own reasoning
gives, is shown `not the line the analysis leans towards`
(`apps/web/src/components/ScenarioStage.tsx:186`) and the API stores
`scenario_attempts.matched_expected = false`.

(A third scenario, `rk-semi-bluff-raise-on-the-turn`, is flagged by the same heuristic but is a
false positive: its prose explicitly puts the raise on the table, so `raise` is the intended answer.)

- **Test covering it:** `packages/content/test/scenarios.test.ts`,
  `apps/api/test/content-routes.test.ts`.
- **Test result:** `@prl/content` 13/13 pass, `content-routes` 5/5 pass. **Neither asserts that the
  action a scenario teaches is one the grading rule accepts** — that gap is why this shipped.
- **Reviewer notes:** The arithmetic is not wrong: `EV(raise) = +126.5` is exactly what the formula
  gives at f = 0.35 and e = 0.167, and I reproduced it independently. The defect is that a fabricated
  input is allowed to override an authored lesson at grading time. The report itself even says so in
  `whatWouldChangeIt` ("This assumes the line wins uncontested 35% of the time"), but the boolean
  written to the database and the chip shown to the learner do not carry that caveat.
- **Missing work:** either (a) let a scenario declare its own `assumedFoldEquity` (a river range
  built to beat hero does not fold 35 % to a raise), or (b) exclude aggressive lines whose entire EV
  comes from the assumed fold branch from `bestEv` in `isDefensible`, or (c) at minimum add a content
  test asserting that for every scenario, at least one action the question offers is in
  `supportedActions`.

---

### MATH-013 The offline fixtures the web app renders still carry pre-fix numbers

- **Requirement (exact):** `apps/web/src/fixtures/scenarios.ts` and `apps/web/src/fixtures/review.ts`
  are generated from `readSituation` + `buildCoachReport` / `buildHandReview` and are rendered to
  learners whenever the API is unavailable. Every number in them must be a number the maths produces
  today.
- **Status:** **FAIL**
- **Implementation location:** `apps/web/src/fixtures/scenarios.ts:959-963` and `:1001-1005`;
  `apps/web/src/fixtures/review.ts:450-454` and `:619-623`. Rendered via
  `apps/web/src/app/lab/[scenarioId]/page.tsx:53`, `apps/web/src/app/lab/page.tsx:107` and
  `apps/web/src/app/review/[handId]/page.tsx:52`, each of which falls back to the fixture when
  `isApiUnavailable(error)` (`apps/web/src/lib/api.ts:141-147`: transport failure, `503`, `501`, any
  `5xx`).
- **Runtime evidence:** the repo's own guard test fails.

```
$ cd apps/api && node --test test/web-fixture-figures.test.ts
✖ the Scenario Lab fixture is the analysis the engine produces today
  ✖ matches buildCoachReport for every bundled scenario
✖ the hand-review fixture is the review the builder produces today
  ✖ REVIEW_HAND_SHOWDOWN replays and analyses identically
  ✔ REVIEW_HAND_FOLDED replays and analyses identically
ℹ tests 3   pass 1   fail 2
```

  That test is inside `apps/api`'s default `test/**/*.test.ts` glob, so `pnpm test:integration` — and
  therefore `pnpm test` — is red on this checkout.

  My own enumeration of every learner-visible field
  (`node scratchpad/agentC/p5-web-fixture.mjs`, which recomputes all six bundled scenarios):

```
################ flop-flush-draw-price
  rule of 2/4   fixture estimate=36.0% err=-2.43pts   computed estimate=36.0% err=+1.03pts
  note fixture : "The rule of 2 and 4 gives 36% here, understating the real figure by 2.4 points."
  note computed: "The rule of 2 and 4 gives 36% on your 9 cards of clean outs, OVERSTATING the exact
                  chance of hitting one of them by 1.0 points."

################ turn-gutshot-price
  rule of 2/4   fixture err=-1.09pts   computed err=-0.70pts

################ flop-spr-commitment
  rule of 2/4   fixture estimate=160.0% err=95.49pts   computed null
  *** FIXTURE SHIPS A "PROBABILITY" OF 160% ***
  note fixture : "The rule of 2 and 4 gives 160% here, overstating the real figure by 95.5 points."
  note computed: (none — the engine refuses the shortcut here)
  candidates:
    check       fixture EV     0.000   computed EV   180.623   <-- differs by -180.623
```

  Four distinct wrong numbers a learner can see:

  1. **`flop-spr-commitment` publishes a probability of 160 %.** `ruleOfThumb.estimate: 1.6` with the
     note *"40 outs with two cards to come, times 4, is roughly 160%"*. The 40 is the fixture's `totalOuts`
     (2 clean + 38 dirty); the engine today passes `cleanCount` and, before that, the live gate
     `ruleOfThumbFor` refuses the shortcut outright because hero is already ahead at 64.5 % —
     above the 0.50 threshold a card has to clear to be an out at all — so it returns `null`. Error: +95.5 percentage points, on
     a quantity that cannot exceed 100.
  2. **`flop-spr-commitment` prices `check` at 0 chips**, with the derivation
     *"Checking costs nothing and keeps you in the hand, so it is worth the same as folding right
     now"* — the exact false claim `evOfCheck` was rewritten to eliminate. The engine computes
     `EV(check) = 0.6451 × 280 = 180.62`. Error: 180.6 chips, and the sentence teaches the
     fold-equals-check fallacy verbatim.
  3. **The direction of the rule-of-2-and-4 error is inverted** in `flop-flush-draw-price`: the
     fixture says the shortcut *understates* by 2.4 points; measured against the chance of hitting
     (34.97 %, which is what the shortcut approximates) it *overstates* by 1.03. The fixture is
     comparing against hero's equity, 38.4 % — the comparison the fix removed because it charges the
     shortcut for the gap between hitting and winning.
  4. **`review.ts` overstates a draw by 28 points.** Line 450: `estimate: 0.6`, note
     *"15 outs with two cards to come, times 4, is roughly 60% … 60% against an exact 43.3%"* — while
     the outs block on the same panel (line 437) reads `clean: 8, dirty: 7, total: 15`. The engine
     today computes `estimate: 0.32` from the 8 clean outs, against a hit probability of 31.5 %. The
     shipped panel therefore contradicts itself, and does so in the aggressive direction. The turn
     decision at line 619 has the same class of error: `errorPoints: -8.139` ("24% against an exact
     32.1%") where the engine computes `-2.087` ("24% against an exact 26.1%").

- **Test covering it:** `apps/api/test/web-fixture-figures.test.ts:100` and `:230`.
- **Test result:** 1 pass, **2 fail** (run above). The sibling fixture guard
  `apps/api/test/legend-fixture-figures.test.ts` passes (3/3), and `apps/web/src/fixtures/legends.ts`
  computes its EVs at render time through the real `evOfCall`/`evOfBet`/`evOfRaise`, so the legends
  path is clean — the defect is confined to these two generated files.
- **Reviewer notes:** The header comments in both fixtures explain that `ruleOfThumb.estimate` is
  "divided by 100 on the way in" to work around a producer that emitted percentage points. That
  workaround was removed from the test and the producer was fixed to emit a fraction — but the
  generated data was never regenerated afterwards, so it still contains the pre-fix values from a
  producer that no longer exists. The raise-EV regeneration (MATH-009) *did* happen; the
  clean-outs-only, compare-against-hit-probability and `EV(check)` fixes did not. This is the one
  finding in my scope where a learner can read a confidently wrong number, which is why it is P0
  rather than P2 despite only being reachable in the degraded path.
- **Missing work:** regenerate both fixtures from the current `buildCoachReport` / `buildHandReview`
  until `apps/api/test/web-fixture-figures.test.ts` is green. Do not hand-edit the numbers — the test
  message says so and it is right.

---

## Severity-classified issues

### P0 — correctness / release catastrophe

- **P0-1 — Shipped offline fixtures publish four wrong learner-visible numbers, including a
  "probability" of 160 %.** (MATH-013.) `apps/web/src/fixtures/scenarios.ts:959-963` ships
  `ruleOfThumb.estimate: 1.6` with the note *"The rule of 2 and 4 gives 160% here"*; `:1001-1005`
  ships `EV(check) = 0` with the derivation *"it is worth the same as folding right now"* against a
  true 180.62 chips; `apps/web/src/fixtures/review.ts:450-454` ships a 60 % draw where the engine
  computes 32 % (28-point overstatement) on a panel that simultaneously prints "8 clean, 7 dirty, 15
  total"; and the direction of the rule-of-2-and-4 error is inverted in `flop-flush-draw-price`
  (fixture "understates by 2.4", truth "overstates by 1.0"). Reached by every Lab and Review screen
  whenever the API returns a transport error or any 5xx. **The repo's own test suite already fails on
  this** (`apps/api/test/web-fixture-figures.test.ts`, 2 of 3 failing), so `pnpm test` is red as
  shipped. Fix: regenerate, do not edit.

### P1 — required behaviour broken

- **P1-1 — Two shipped scenarios grade their own taught answer as not defensible.** (MATH-012.)
  `rk-the-fold-that-feels-wrong` ("Folding top pair, top kicker", question *"Should hero call or fold
  the big river bet?"*, reasoning *"folding is better than calling"*) and
  `eq-implied-odds-deep-stacks-turn` (question *"Should hero call or fold?"*) both resolve to
  `supportedActions = {raise}`: a learner picking either option the question offers is told
  `not the line the analysis leans towards` and gets `matched_expected = false` in the database. Root
  cause is the flat `DEFAULT_ASSUMED_FOLD_EQUITY = 0.35` (`packages/poker-math/src/coach.ts:165`)
  feeding `bestEv` in `isDefensible` (`packages/poker-math/src/consistency.ts:108-116`). No test
  covers "the action the scenario teaches is in the defensible set".

### P2 — significant quality gap

- **P2-1 — The Coach headlines `raise` in 30 of the 36 shipped scenarios (5 fold, 1 call)**, because
  the flat 35 % assumed fold equity makes some raise almost always the top row. It overrides the
  lesson in scenarios whose whole subject is that the price is wrong — `eq-break-even-equity-and-bet-size`
  (equity 20.6 %, needs 33.3 %, call EV −34.4) headlines `raise to 180` at +6.3; `eq-dominated-flush-draw-turn`
  (equity 20.5 %, needs 30.6 %) headlines `raise to 115` at +8.9; `eq-second-pair-vs-narrow-range`
  (equity 15.9 %, needs 27.3 %) headlines `raise to 133` at +7.5. The extreme case is
  `rk-pricing-a-river-bluff-raise`, where hero's equity is exactly **0.0 %** and the raise scores
  +15.0 purely on the assumed fold rate — on-topic for that one scenario, but it shows how little the
  headline depends on the hand. The arithmetic is right in every case; the uniform assumption is what
  makes the panel systematically favour aggression, which is the one direction a teaching product
  must not lean. Evidence: `scratchpad/agentC/p7-scenarios.mjs` and `p8-consistency.mjs` output.

### P3 — polish

- **P3-1 — The rule-of-2-and-4 explanation contradicts the outs definition on the same panel.**
  `ruleOf24`'s explanation string (`packages/poker-math/src/odds.ts:310`) says *"Count clean outs
  only: a card that improves hero but hands an opponent a better hand at the same time is not an
  out"*, while `computeOuts` defines `totalOuts = cleanCount + dirtyCount` and the Coach's teaching
  note prints *"…out of 15 outs in total"*. Both sentences can appear together.
- **P3-2 — `combineMonteCarlo` pools only within-shard variance** (`packages/poker-math/src/equity.ts:681-688`): it drops the
  between-shard term and weights by `n` rather than `n−1`, so the pooled 95 % interval is very
  slightly narrow by construction. Measured at 0.0004 % of its own width over 4×25 000 shards —
  immaterial in practice, but it is a systematic understatement rather than noise.
- **P3-3 — The reported confidence interval is hero's only, but the summary does not say so.**
  `CoachReport.uncertainty.summary` reads *"The 95% confidence interval is ±X percentage points"*
  while `equity.perPlayer` lists every player's equity. Measured in a sampled 3-way spot: hero
  ±0.365 pts, each opponent ±0.286 pts. Heads-up the two are identical, so this only bites multiway.
- **P3-4 — `describeScore` omits the deciding kicker** for two pair ("two pair, aces and kings") and
  for four of a kind, so two hands the evaluator correctly ranks differently get identical prose in
  Coach and outs explanations (`packages/poker-engine/src/evaluate.ts:265-292`, `twoPair` branch at `:281`).

---

## Test runs I executed

```
packages/poker-math  : node --test 'test/**/*.test.ts'   -> 232 tests, 232 pass, 0 fail
packages/poker-engine: node --test 'test/*.test.ts'      -> 119 tests, 119 pass, 0 fail
packages/content     : node --test 'test/**/*.test.ts'   ->  13 tests,  13 pass, 0 fail
apps/api (subset)    : node --test test/legend-fixture-figures.test.ts test/calc.test.ts \
                                  test/content-routes.test.ts
                                                          ->  65 tests,  64 pass, 0 fail, 1 skipped
apps/api             : node --test test/web-fixture-figures.test.ts
                                                          ->   3 tests,   1 pass, 2 FAIL
```

The package suites do assert (I read the failing-path messages and confirmed the assertions are real,
not vacuous). The one red suite is the fixture guard, and it is red for the right reason.
