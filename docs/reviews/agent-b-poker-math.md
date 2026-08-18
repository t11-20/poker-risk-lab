# Agent B — Poker Rules & Mathematics (adversarial review)

**Reviewer:** independent (did not write this code)
**Date:** 2026-08-18
**Scope:** Hold'em rules correctness, hand evaluation, all the probability/EV/variance/ICM
mathematics, the Coach's numbers, and a hunt for hard-coded odds.
**Status:** **FAIL** — 1 × P0, 3 × P1, 3 × P2, 3 × P3.

Method: I did not take any existing test, comment or doc as evidence. I derived every figure
independently (closed forms by hand, published equity anchors, my own Malmuth–Harville
recursion), wrote my own scratch harnesses against the built packages, drove real dealt hands
through the state machine, fuzzed 4,000 randomised all-in hands, and confirmed the headline
findings end-to-end against the **running** API on `127.0.0.1:3001`.

---

## Executive summary

The pure mathematics in `packages/poker-math` is, with one exception, excellent — better than
most published poker material. Every closed form I checked is right, including the two that are
most often misquoted (`priceLaidByBet = b/(pot+2b)` and `alpha = b/(pot+b)`, kept
deliberately distinct). The rules engine conserves chips to the chip across 4,000 randomised
all-in hands, builds side pots correctly, and the hand evaluator passes a genuine exhaustive
133,784,560-hand check against independently published frequencies. There are **no hard-coded
odds** anywhere in the content: quiz answers are computed at request time from the maths
package, which I verified for all 24 numeric questions through the live API.

The exception is severe, and it is in the feature the code itself calls "the product". **The
Coach computes the EV of a raise as if it were an opening bet**, never charging hero the chips
it must put up to call. Every raise EV in the app is overstated by
`(1 − f) × toCall × (1 − equity)`. Measured against the live API, this affects **33 of the 34**
shipped Scenario Lab scenarios that have a raise candidate; the Coach recommends `raise` in
**34 of 34** of them, including two where hero has **0.0 % equity** (drawing dead); and in 4
scenarios it marks a learner's *correct fold* as "not consistent with this analysis". A related
`to`-arithmetic error makes **21 of 34** suggested raise sizes smaller than the engine's own
minimum legal raise.

Two further rules defects: every non-heads-up seat is given the wrong position label in the
state clients receive (the small blind is labelled "CO"), and all-in run-outs are not run out —
the last player with chips is prompted on every street and offered a **fold** that forfeits a
pot it has already fully paid for.

---

## What I verified as CORRECT

Listing this explicitly because an empty finding list is only meaningful if someone actually
looked. Each of these was derived independently and then checked against the code.

### Rules (own harness, real dealt hands)

| Requirement | Result |
|---|---|
| Heads-up: button posts SB, acts **first** preflop, **last** postflop | correct, verified on a real dealt hand at seats 3 & 5 of a 6-max table |
| Action order 3–6 handed with seat gaps (0, 2, 5 occupied) | correct preflop and postflop |
| Minimum raise by **increment**: over a bet of 20, a raise to 100 makes the next minimum **180** | correct — `180`, not 200, not 120. `raise to 179` is rejected. Postflop opening bet minimum = BB; after bet 20 → raise 100, next minimum 180 |
| Short all-in does **not** reopen the action for a player who already acted at the full-raise level | correct — that seat gets only `["fold","call"]` and a raise attempt throws with an accurate message |
| …but **does** leave an unacted player free to raise | correct — unacted seat gets `raise` with `minTo = 125` (= 75 + the 50 increment) |
| A later **full** raise re-opens the action to everyone | correct |
| Short blind post (BB all-in for less than the SB) | correct: `wasShort: true`, seat is `allIn` not folded, 5 uncalled returned, net +5 / −5 |
| All-in for less than a call | correct: call capped at the stack, `allInAtMax: true` |
| Everyone all-in preflop, 4 distinct amounts | correct across `[100,200,300,400]`, `[55,55,300,1000]`, `[7,13,19,23]`, `[1,1000,1000,1000]` |
| Multiple side pots, 3+ distinct all-ins | correct: `[100,300,600,600]` → 400 / 600 / 600 with the right eligibility sets |
| Side pot with a folded contributor | correct — folded seat contributes, is eligible for nothing |
| Side pot with the **largest** contributor folded | correct — uncontestable excess returned, chips balance |
| Ties inside a side pot | correct |
| **Chip conservation**, 4,000 randomised hands (2–6 seats, gaps, random stacks 1–400, random legal actions) | **0** failures: no chips created/destroyed, no negative stacks, `net` always sums to 0, awards always equal pot layers, no stuck states, no throw on a `legalActions`-approved action |
| Odd chips go left of the button, deterministically; follow the button when it moves | correct — 100/3 chop gives the odd chip to `(button+1)` for every button position |

### Hand evaluation

Every case from the brief, plus the exhaustive suite:

- wheel is a straight and is the **lowest** straight ✓
- `K-A-2-3-4` is **not** a straight (nor `Q-K-A-2-3`) ✓
- steel wheel is a straight flush, and below a 6-high straight flush ✓
- two trips in seven cards → full house with the **lower trip as the pair** ("aces full of kings") ✓
- quads + a pair → **four of a kind with a kicker**, not a full house ✓
- counterfeited two pair re-reads correctly ("two pair, nines and fives") ✓
- three pairs in seven → best two pair with the third pair's rank available as the kicker ✓
- category ordering (SF > quads > boat > flush > straight), 6-card evaluation, flush picks the top five ✓

```
pnpm run test:exhaustive
  enumerated 133,784,560 hands in 6.5s (20675k hands/s)
  ✔ EXHAUSTIVE: all 133,784,560 seven-card hands classify to the published frequencies
```

This is real verification, not a regression lock: the expected counts (23,294,460 / 58,627,800 /
31,433,400 / 6,461,620 / 6,180,020 / 4,047,644 / 3,473,184 / 224,848 / 41,584) are the published
combinatorial result and sum to C(52,7). The 5-card path is additionally cross-checked against a
deliberately differently-written reference evaluator in `test/reference-evaluator.ts`.

### Mathematics

All derived independently, then compared:

- **Break-even equity** `= toCall/(pot+toCall)`: `potOdds(100,50) = 1/3`, ratio 2 ✓. `toCall = 0`
  short-circuits to 0 rather than `NaN`, ratio `Infinity` with the reason stated in words ✓
- **The price a bet lays a caller** `= b/(pot+2b)`: a pot-sized bet lays **exactly 1/3**, a
  half-pot bet exactly 1/4 ✓, checked over a sweep. `priceLaidByBet` delegates to `potOdds` with
  the bet already in the middle so the two cannot drift. The file explicitly separates this from
  `alpha = b/(pot+b)` and explains the confusion — this is the formula the brief warns is most
  often misstated, and it is right
- **MDF + alpha = 1** ✓ for every pot/bet pair tested
- **EV(call) = 0 at exactly break-even equity** ✓ (four independent pot/call pairs)
- **Two-card hit probability** `1 − ((u−o)/u)((u−o−1)/(u−1))` ✓ exactly, including the
  `misses < 2` guard (returns 1, not a negative-probability product)
- **Rule of 2/4 error, direction and magnitude**: ×4 at 4 outs **understates** by 0.47 pts (16 vs
  16.47), at 9 outs overstates by 1.03 (36 vs 34.97), at 15 outs overstates by 5.88 (60 vs
  54.12); ×2 always understates (−0.70 / −1.57 / −2.61). Every figure quoted in the `caveat`
  prose — 54.1 %, 16.5 %, 19.6 %, 32.6 %, the 5.9-point overstatement, the 38.7 % naive-addition
  claim — checks out to the stated precision
- **Fold equity round-trips to zero**: `requiredFoldEquity` → `evOfBet` gives EV = 0 to ≤ 2.3e-14
  for every feasible case. `f*(e=0)` equals `alpha` exactly, from two independent derivations.
  Degenerate branches handled correctly: profitable at zero fold equity returns 0 with an
  explanation (not a clamped fraction), and pot = 0 returns f = 1 with the reason
- **EV endpoints**: `f=1 → pot` exactly; `f=0 →` exactly `evOfCall(pot+b, b)`; term contributions
  sum to `ev` and term probabilities sum to 1; semi-bluff halves sum to `ev` exactly
- **Published equities** (exact enumeration, all suit configurations, blockers removed):
  AA vs KK = **81.946 %** (published ≈ 81.9), AKs vs 22 = **49.893 %** (≈ 50), AKo vs QQ =
  **43.242 %** (≈ 43), AKs vs QQ = 46.049 %, JTs vs AA = 21.160 %. 36 matchups × C(48,5) =
  61,642,944 boards ✓
- **Blockers are removed** — the error the brief flags as common and significant: `AhAd` against
  the range `AA` yields exactly **1** legal matchup (only `AcAs` remains), and this holds even
  when the range was *not* pre-blocked, because `enumerateMatchups` rejects card overlap itself.
  Board cards and `deadCards` also block. Fully-overlapping ranges **throw** rather than
  fabricate a number
- **Ties award 1/k**: a certain two-way chop gives equity exactly `0.5` with `tie = 1, win = 0`;
  a three-way chop gives exactly `1/3` each; two chopping plus one loser gives 0.5 / 0.5 / 0
- **Monte Carlo**: deterministic per seed ✓; interval widens monotonically as n falls and scales
  as 1/√n (200 k → 2 k gives a ratio of 9.95 against a theoretical 10) ✓; empirical coverage
  277/300 = 92.3 % against a nominal 95 % ✓; unbiased — the mean of 300 independent runs sits
  0.016 pts from the exact truth against a standard error of 0.063 pts ✓; rejection sampling for
  matchups and a *partial Fisher–Yates* for the run-out, both unbiased ✓
- **Shard combination recomputes from the pooled n, not by averaging** ✓ — 4 × 25 k gives a
  half-width of 0.27907 pts, matching a single 100 k run's 0.27934 (0.1 % apart), where averaging
  the shard intervals would have reported 0.55815. Equity is the trial-weighted mean
- **Variance scaling**: mean linear, deviation √n, verified by ratio (4× hands → 4× mean, 2× sd);
  `P(loss) = Φ(−E/σ)` exactly; `N = 100(z·sd/halfWidth)²` round-trips, and halving the
  half-width quadruples the hands to 1e-4
- **`normalCdf` accuracy**: worst absolute error **6.999e-8** across 11 independently-known
  values (Φ(1), Φ(1.96), Φ(2), Φ(3), Φ(4), Φ(6), the 95 % and 99.5 % quantile points), inside the
  documented 7.5e-8. `Φ(0)` returns exactly 0.5; reflection is exactly symmetric.
  `normalQuantile(0.975) = 1.959963986` vs the true 1.959963985
- **Risk of ruin** `= exp(−2Bw/σ²)` exactly (`exp(−1)` for 1000 bb / 5 / 100); ruin = 1 for
  `w ≤ 0`; the inverse round-trips to 1e-9 relative at four targets; doubling the bankroll
  squares the risk exactly
- **ICM**: 3:1 stacks with 70/30 payouts gives **exactly 60/40** ✓. A single prize is exactly
  chip-linear (75/25) ✓. A 3-player case matches my own hand-rolled Malmuth–Harville recursion
  to 1e-9 ✓. Equities sum to the prize pool ✓. Concavity holds (gaining 500 gains 5.167, losing
  500 loses 5.833) ✓. Busted players take the bottom prizes; two busted share them ✓. Every
  hostile input (10 players, negative/NaN stack, Infinity payout, more payouts than players, all
  stacks zero, empty) throws a specific `IcmError`
- **SPR / stacks**: `SPR = eff/pot` ✓; `effectiveStack = min(hero, max(opponents))` ✓ (documented
  and correct for the multiway case); sizing-ladder amounts are `floor(fraction × pot)` and
  integral ✓; `commitmentThreshold` at SPR 4 gives exactly 1 ✓ and clamps to 0 with an
  explanation when the pot exceeds the stack; `M = stack/(sb+bb+antes)` ✓, and it **refuses to
  guess** when an ante is given without `playersAtTable`
- **Outs, clean/dirty split**: defensible and documented. The brief's requested case works
  exactly: `Ah Kh` on `7h 2h 9c` against a set (`9s 9d`) gives **0 clean outs**, 8 dirty — a
  "9-out flush draw" with fewer than 9 clean outs, and the code agrees. The `9h` is correctly
  *neutral* (it fills the opponent's boat). The same draw against `Qs Jd` gives 9 clean hearts.
  Raising `cleanThreshold` to 0.99 moves 23 cards from clean to dirty, proving the thresholds are
  a parameter rather than a hidden constant; they are named in `assumptions` on every result. The
  out count cross-checks against the closed form to 3 decimal places (40 outs / 44 unseen =
  90.909 % both ways). All 11 hostile inputs throw specific `OutsError`s
- **No hard-coded odds in content.** `packages/content/data/**` contains no percentage or "X to
  1" literal at all. Every numeric quiz question carries a `calculation` (kind + inputs) and a
  `field`; the answer is computed by `poker-math` at request time and is deliberately not stored
  ("a stored answer key is a number that can silently disagree with the maths"). I submitted all
  24 through the live API and every one returned a computed `expected` value consistent with the
  question prose — spot-checked by hand: `potOdds(60,20) → 3 to 1`; `potOdds(9,4) → 30.77 %`;
  `callEv(120,40,0.4) → 24`; `foldEquity(100,50,0.5,0.3) → 55`; `90·√1000 → 2846.05`;
  `exp(−2·1000·3/8100) → 47.68 %`; `8/21 → 38.10 %`. Bet-sizing questions correctly express the
  bet price as `potOdds(pot+b, b)`, giving 25 % for a half-pot bet and 40 % for a 2× overbet
- The `apps/web/src/fixtures/review.ts` figures are **not** fabricated: I reproduced
  `heroEquity`, `win`, `tie`, `trials` and the 227-combination blocker count **bit-for-bit** from
  the real enumerator, and every price string in it (20 %, 28.6 %, 45 %, alpha 25/40/81.8 %, MDF
  75/60/18.2 %, `potOddsOfferedByPotSizedBet = 1/3`) is arithmetically correct

All 591 package tests pass (`pnpm run test:unit`, exit 0): poker-engine 85, poker-math 187,
ui 169, content 13, poker-ai 137, contracts 0. **None of them catches any finding below.**

---

# FINDINGS

## P0-1 — The Coach computes the EV of a **raise** as if it were an opening bet, so every raise EV in the app is overstated and the recommendation is frequently wrong

**Location:** `packages/poker-math/src/coach.ts:241-256` (`buildCandidates`), specifically
`betSize: option.amount` on line 243 and `to: input.toCall === 0 ? option.amount : input.toCall + option.amount`
on line 250.

**Problem**

For an aggressive candidate the Coach calls
`evOfBet({ pot, betSize: option.amount, foldProbability: f, equityWhenCalled: e })`.
`evOfBet` models *hero risking `b` into a pot of `pot`*:

```
EV = f·pot + (1−f)·[ e·(pot + 2b) − b ]
```

That is correct for a **bet** (`toCall === 0`), and I confirmed it is exactly right there. It is
wrong for a **raise**. When hero raises by `R` while facing `C` to call, hero risks `C + R`, not
`R`; the opponent adds `R` to call; and the final pot is `pot + (C+R) + R`. The honest
expression is

```
EV(raise) = f·pot + (1−f)·[ e·(pot + C + 2R) − (C + R) ]
```

The Coach never charges hero the `C`. The error in each raise candidate is exactly

```
(1 − f) · C · (1 − e)
```

— the chips hero must put up to call, weighted by how often it loses them. It is always an
**overstatement**, it grows with the size of the bet hero is facing, and it grows as hero's
equity falls. So the model is most wrong precisely where a learner most needs it to be right:
facing a big bet with a weak hand.

The `to` value is wrong for the same reason. `to = toCall + amount` silently assumes hero's
existing street commitment equals `toCall`, which is only true by coincidence. See **P1-3**.

**Reproduction — live API, servers as provided**

```
$ curl -s http://127.0.0.1:3001/api/v1/health
{"status":"ok","version":"0.1.0","protocolVersion":1}

POST /api/v1/math/coach   (session + x-csrf-token + Origin: http://localhost:3000)
{"heroCards":"7c2d","board":"AhKdQs","street":"flop",
 "opponents":["22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo"],
 "pot":400,"toCall":300,"heroStack":2000,"opponentStacks":[2000],"bigBlind":10}
```

Live response — hero holds **7-2 offsuit on A-K-Q**, equity **5.10 %**, break-even **42.86 %**:

```
  fold   to=-     cost=0     ev=      0.000
  call   to=300   cost=300   ev=   -264.307
  raise  to=433   cost=133   ev=     75.624     <-- correct value: -109.433
  raise  to=566   cost=266   ev=     -2.010     <-- correct value: -187.067
  raise  to=2000  cost=1700  ev=   -839.053     <-- correct value: -1024.110

SUGGESTION: {
 "action": "raise",
 "sizeRange": { "min": 433, "max": 2000 },
 "confidence": "reasonable",
 "reason": "raise has the highest expected value against the stated range,
            by 75.6 chips over the next-best action."
}
```

The Coach recommends **raising 7-2 offsuit with 5.1 % equity for a claimed +75.6 chips, at its
second-highest confidence level**. The correct answer is fold (EV 0); the raise is worth
−109.4. The overstatement is `0.65 × 300 × (1 − 0.051) = 185.06`, exactly as predicted.

The `derivation` string the learner is shown gives the bug away if read closely — it is labelled
`EV(bet)` and substitutes `b = 133` with no mention of the 300:

```
"EV(bet) = f x pot + (1 - f) x [ e x (pot + 2b) - b ]
         = 0.35 x 400 + 0.65 x [ 0.051 x (400 + 2 x 133) - 133 ]
         = 140 + (-64.38) = 75.62 chips. Risks 133 to win 400. ..."
```

"Risks 133" is false: hero risks 433.

**Reproduction — impact across the shipped Scenario Lab, read from the live API**

For every scenario I fetched `GET /api/v1/content/scenarios/:id` and compared the report's own
candidate EVs with the corrected formula at the same equity, pot and `toCall`:

```
scenario                                   pot toCall    eq% coachBestEV trueBestEV coachAct trueAct foldGraded foldTruth
fl-top-pair-weak-kicker-river              140     45    0.0        19.1        0.0    raise    fold      False      True   <<< CHANGES
fl-gutshot-facing-turn-bet                 155     60    9.1        36.3        0.8    raise   raise      False      True   <<< CHANGES
fl-overcards-dirty-outs                     95     40   14.0        27.4        5.1    raise   raise      False      True   <<< CHANGES
rk-pricing-a-river-bluff-raise             600    120    0.0        80.0        2.0    raise   raise      False      True   <<< CHANGES
eq-flush-draw-turn-overbet                 360    240   26.8       152.5       38.3    raise   raise      False     False
eq-break-even-equity-and-bet-size          180     90   20.6        64.2       17.7    raise   raise      False     False
eq-implied-odds-deep-stacks-turn           250    120   22.2        93.5       32.8    raise   raise      False     False
rk-semi-bluff-raise-on-the-turn            370    150   19.2       126.5       47.8    raise   raise      False     False
rk-the-fold-that-feels-wrong               900    400   16.7       343.2      126.5    raise   raise      False     False
rk-when-survival-outweighs-chip-ev       26000  22000   54.4     18400.2    11873.7    raise   raise      False     False
  ... (34 rows total)

LIVE API: scenarios with toCall>0 and a raise candidate: 34
raise EVs overstated in: 33
grading verdict / recommended action changes once corrected: 4
  -> ['fl-top-pair-weak-kicker-river', 'fl-gutshot-facing-turn-bet',
      'fl-overcards-dirty-outs', 'rk-pricing-a-river-bluff-raise']
```

Three consequences, all confirmed live:

1. **33 of 34** shipped scenarios show overstated raise EVs.
2. The Coach's recommended action is `raise` in **34 of 34** — including
   `fl-top-pair-weak-kicker-river` and `rk-pricing-a-river-bluff-raise` where hero's equity is
   **0.0 %** (drawing dead) and the Coach nonetheless prices a raise at +19.1 and +80.0. The
   scenario literally titled *"The Fold That Feels Wrong"* has the Coach recommending a raise at
   +343.2.
3. **Learner answers are mis-graded.** `consistencyOf` in `apps/api/src/routes/content.ts:734`
   judges a fold defensible only when `bestOverall(report).ev <= margin` (one big blind). The
   inflated raise EV pushes `bestOverall` over the margin, so in the 4 scenarios above **a
   learner who correctly folds is told their fold is "not consistent with this analysis"**, and
   a learner who raises with 0 % equity is told it *is* consistent. This flows through both
   `POST /content/scenarios/:id/attempt` and the two `decision`-kind quiz questions.

**Evidence**

`packages/poker-math/src/coach.ts:241-256` —

```ts
const bet = evOfBet({
  pot: input.pot,
  betSize: option.amount,          // <-- the raise INCREMENT only; input.toCall is never charged
  foldProbability: foldEquity,
  equityWhenCalled: heroEquity,
  callerCanRaise: true,
});
candidates.push({
  action: input.toCall === 0 ? 'bet' : 'raise',
  to: input.toCall === 0 ? option.amount : input.toCall + option.amount,
  cost: option.amount,             // <-- and the reported cost omits it too
  ev: bet.ev,
  ...
```

`evOfBet`'s own doc comment states its contract precisely, and it is not the raise:

> `pot` is what is in the middle BEFORE the action … `b` is the bet.
> Set f = 0 and what is left is `e x (pot + 2b) - b`, which is precisely `EV(call)` for someone
> facing a bet of `b` into a pot of `pot + b`.

`evOfBet` is not at fault — it is correct and correctly documented. The Coach is using it for a
spot it does not describe.

Control experiment, same helper, `toCall = 0` — the model is exact when it really is a bet:

```
===== a PURE BET (toCall = 0) =====
action to     cost      COACH ev   CORRECT ev     error
bet    65     65         117.522      117.522     0.000
bet    130    130        111.881      111.881     0.000
bet    875    875         47.224       47.224     0.000
```

The same wrong figures are also baked into `apps/web/src/fixtures/review.ts:506` and rendered on
the shipped `/review/[handId]` page (`ev: 117.522` for "raise to 130" at `toCall: 65`; correct
value 93.576).

**Fix**

Charge hero the call. Either add a raise-aware function to `ev.ts`, e.g.

```ts
export function evOfRaise(input: {
  pot: number;            // chips in the middle before hero acts, incl. the bet being faced
  toCall: number;         // what hero must add to match
  raiseBy: number;        // increment on top of the call
  foldProbability: number;
  equityWhenCalled: number;
}): EvBreakdown {
  const risk = input.toCall + input.raiseBy;
  const called = input.equityWhenCalled * (input.pot + risk + input.raiseBy) - risk;
  return /* f·pot + (1−f)·called, with terms and derivation */;
}
```

or, equivalently and with no new function, call the existing one with the raise re-expressed as
a bet into the pot hero would be creating. Also fix `cost` to be `toCall + raiseBy` and take
hero's actual `committedThisStreet` as a Coach input so `to` can be computed as
`committedThisStreet + toCall + raiseBy` (see P1-3). The `derivation` string must stop saying
`EV(bet)` and "Risks {increment}" for a raise. Re-generate the review fixture afterwards.

**Missing test**

A test that pins each candidate EV against a value derived *outside* the function, not against
another call of it. Concretely, in `packages/poker-math/test/coach.test.ts`:

1. `evOfRaise` (or the Coach's raise candidate) at a spot with `toCall > 0` must equal a
   literal computed by hand in the test body: for `pot 400, toCall 300, raiseBy 133, f 0.35,
   e 0.051`, assert `-109.43 ± 0.01`.
2. An invariant test: for every raise candidate,
   `candidate.cost === input.toCall + ladderIncrement` and
   `candidate.ev <= evOfBet({pot, betSize: candidate.cost, ...}).ev` — a raise can never be worth
   more than a bet of the same total risk into the same pot.
3. A monotonicity test that would have caught this directly: hold everything fixed and increase
   `toCall`; every raise EV must **fall**. Today it does not move at all.
4. A "never recommend aggression while drawing dead" test: at `equity === 0` with `f` at the
   default, no candidate may have `ev > f × pot` and `suggestion.action` must not be `raise`
   when folding is available and every alternative is negative. `fl-top-pair-weak-kicker-river`
   and `rk-pricing-a-river-bluff-raise` are ready-made fixtures.
5. Note the existing test that *should* have caught this and cannot: `'the price drives the
   decision: the same draw flips from raise to fold as the bet grows'` uses
   `flushDrawVsSet({ pot: 100, toCall: 400, heroStack: 400 })`, where
   `maxBet = heroStack − toCall = 0`, so **no raise candidate is produced at all** — the
   candidate list is `["fold","call"]`. It passes for a reason unrelated to its name. Give it a
   stack that leaves chips behind.

---

## P1-1 — `positionLabels` mislabels every seat at a 3+ handed table; "SB" and "BB" are never emitted, and the small blind is reported as the cutoff

**Location:** `packages/poker-engine/src/positions.ts:137` inside `positionLabels`, caused by
`orderFrom` at `positions.ts:42`.

**Problem**

`orderFrom(from, maxSeats, occupied)` is documented at line 36 as *"Occupied seats ordered
clockwise starting at `from` (**exclusive**)"*. It is not exclusive. The loop runs
`for (let step = 1; step <= maxSeats; step++)`, and at `step === maxSeats` the candidate is
`(from + maxSeats) % maxSeats === from`, so **`from` is always the last element returned**.

Three callers rely on that inclusive behaviour and are correct (ante posting, hole-card deal
order, and `seatOrderFromButton` for odd chips — the button should indeed be last in line).
`positionLabels` does not:

```ts
const rest = orderFrom(bigBlindSeat, maxSeats, occupied).filter((seat) => seat !== buttonSeat);
```

`rest` is meant to be "the seats from under the gun round to the cutoff". Because `orderFrom`
wraps all the way round, `rest` also contains the **small blind and the big blind itself**. The
subsequent `labels.set(seat, name)` calls then overwrite the correct `SB` and `BB` entries, and
the name list runs out so trailing seats fall through to `'MP'`.

**Reproduction**

```
$ node -e "... positionLabels(btn, 6, occupied) ..."
2-handed btn=0 SB=0 BB=1 -> [[0,"BTN/SB"],[1,"BB"]]                                   <- correct
3-handed btn=0 SB=1 BB=2 -> [[0,"BTN"],[1,"UTG"],[2,"CO"]]                            <- SB->UTG, BB->CO
4-handed btn=0 SB=1 BB=2 -> [[0,"BTN"],[1,"HJ"],[2,"CO"],[3,"UTG"]]
5-handed btn=0 SB=1 BB=2 -> [[0,"BTN"],[1,"HJ"],[2,"CO"],[3,"UTG"],[4,"UTG+1"]]
6-handed btn=0 SB=1 BB=2 -> [[0,"BTN"],[1,"CO"],[2,"MP"],[3,"UTG"],[4,"UTG+1"],[5,"HJ"]]
6-handed btn=2 SB=3 BB=4 -> [[0,"UTG+1"],[1,"HJ"],[2,"BTN"],[3,"CO"],[4,"MP"],[5,"UTG"]]

orderFrom(4,6,[0..5]) = [5,0,1,2,3,4]   <-- doc says "(exclusive)"; 4 is present
```

And through `redactFor`, which is the recipient-specific state every client receives:

```
SIX-HANDED, button = seat 0. What every client is told each seat's position is:
  seat 0  position="BTN"   (button)
  seat 1  position="CO"
  seat 2  position="MP"
  seat 3  position="UTG"
  seat 4  position="UTG+1"
  seat 5  position="HJ"

forced bets actually posted:
  [{"kind":"smallBlind","seat":1,...},{"kind":"bigBlind","seat":2,...}]
```

Seat 1 posts the small blind and is labelled **CO**. Seat 2 posts the big blind and is labelled
**MP**. `assignBlinds` and every action-order function are correct — only the labels are wrong.

**Evidence / blast radius**

`positionLabels` is consumed by:

- `packages/poker-engine/src/redact.ts:121` → `SeatView.position` in the state sent to every
  client, i.e. the live table UI
- `apps/web/src/lib/scenario-view.ts:111` → the Scenario Lab table
- `apps/web/src/lib/hand-replay.ts:439` → Hand Review replay

Position is an explicitly required teaching topic ("Teaches: rules, blinds, **position**"), so
this teaches something false wherever a seat label is rendered.

The only existing test of this function, `packages/poker-engine/test/betting.test.ts:74`, checks
`positionLabels(0, 2, [0, 1])` — the single heads-up case that happens to return early before the
broken code path. It is a textbook example of a test whose name implies coverage it does not have.

**Fix**

In `positionLabels`, exclude the blinds as well as the button:

```ts
const rest = orderFrom(bigBlindSeat, maxSeats, occupied)
  .filter((seat) => seat !== buttonSeat && seat !== smallBlindSeat && seat !== bigBlindSeat);
```

Separately, either rename `orderFrom` / fix its doc comment to say it **includes** `from` as the
final element, or add an explicit `inclusive` parameter. The current comment is actively
misleading and is the root cause here.

**Missing test**

A table-driven test asserting the **complete** label map for 2, 3, 4, 5 and 6 occupied seats, at
several button positions, and at a table with gaps (`[0, 2, 5]`). Two invariants worth asserting
directly, because they catch the whole class:

- `labels.get(assignBlinds(...).smallBlindSeat) === 'SB'` (or `'BTN/SB'` heads-up) and
  `labels.get(bigBlindSeat) === 'BB'`, for every table size and button position
- every occupied seat gets exactly one label, and no label appears twice

---

## P1-2 — All-in run-outs are not run out: the last player with chips is asked to act on every street, and is offered a **fold** that forfeits a pot it has already fully paid for

**Location:** `packages/poker-engine/src/betting.ts:124-137` (`isBettingClosedForHand`) together
with `packages/poker-engine/src/machine.ts:423` (`closeStreet`).

**Problem**

`isBettingClosedForHand` has an explicit branch for the commonest all-in shape — one player with
chips against all-in opponents:

```ts
// One player with chips against all-in opponents: once the bet is matched
// there is nothing left to bet into.
if (withChips.length === 1) {
  const [only] = withChips;
  if (only === undefined) return true;
  return !owesAction(state, only) && only.committedThisStreet >= state.betLevel;
}
```

That branch is **dead**. It is only ever evaluated from `advanceStreets`, which runs *after*
`closeStreet`, and `closeStreet` resets every seat's `lastActedAtBetLevel` to `null`
(`machine.ts:423`). `owesAction` returns `true` whenever `lastActedAtBetLevel === null`, so
`!owesAction(only)` is always `false` at a street boundary and the function always returns
`false`. `advanceStreets` therefore deals one street and stops, contradicting its own doc
comment ("when no further betting is possible … it runs the board out to the river and shows
down in one pass").

The remaining player is then handed a full action set — including `fold` and `bet` — against
opponents who have no chips. **Folding there is not a legal action in poker** (once the action is
closed the cards are tabled and the board runs out), and it forfeits a pot hero has already paid
for in full and cannot be raised out of.

**Reproduction**

```
$ node -e "... startHand HU 1000 vs 200, button shoves 200, seat1 calls all-in ..."
after seat1 calls all-in: street= flop  toAct= 0  board= 3
seat statuses [[0,"active",800],[1,"allIn",0]]
isBettingClosedForHand = false

LEGAL ACTIONS OFFERED TO THE LONE CHIPPED PLAYER ON THE FLOP:
[{"type":"fold","note":"Legal, but checking costs nothing."},
 {"type":"check","costAtMin":0,"note":"Stay in the hand for free."},
 {"type":"bet","minTo":20,"maxTo":800,"costAtMin":20,"allInAtMax":true,"note":"Open the betting."}]

  street flop asks seat 0 to act
  street turn asks seat 0 to act
  street river asks seat 0 to act
needed 3 extra CHECK actions to finish an all-in run-out; final street complete
```

The consequence, with cards fixed so the outcome is unambiguous:

```
AA vs KK all-in preflop, seat1 all-in for 200, seat0 covers. street= flop
seat0 holds Ah Ad   seat1 holds Ks Kc

--- seat0 FOLDS on the flop (an action real poker does not allow) ---
final stacks [[0,800],[1,400]]
net {"0":-200,"1":200}
endedByFold true showdowns 0

--- for comparison, checking it down ---
final stacks [[0,1200],[1,0]] net {"0":200,"1":-200}
```

Hero folds aces after being all-in called and loses 200 chips it could not have been raised off.
Note also `endedByFold: true` and `showdowns: 0`, so the hand is recorded in review as having
ended by a fold when it was an all-in — and no cards are revealed.

A milder instance of the same root cause: with the big blind all-in for less than the small
blind, the small blind is offered `{"type":"raise","minTo":30,"maxTo":500}` — a raise nobody at
the table can call.

Chips are conserved in every variant (verified: 505 in, 505 out; and 0 conservation failures
across the 4,000-hand fuzz), so this creates and destroys nothing. `timeoutAction` also does the
right thing (`check`, never `call`). The defect is the over-permissive action set plus the
missing automatic run-out.

**Evidence**

`isBettingClosedForHand` returning `false` in the trace above is the whole proof: the branch that
exists to return `true` there cannot, because `closeStreet` has already nulled the field the
branch tests. Correct behaviour is visible in the adjacent case — when *nobody* has chips,
`withChips.length === 0` returns `true` early and the board does run out in one pass (verified:
"everyone all-in preflop → complete, board 5 cards").

**Fix**

Make the one-chipped-player branch independent of `lastActedAtBetLevel`. The question it is
trying to ask is "is there anyone left who could call a bet?", and the answer does not depend on
whether the sole remaining player has acted this street:

```ts
if (withChips.length === 1) {
  const [only] = withChips;
  if (only === undefined) return true;
  // Nobody else can put chips in, so the only thing that matters is whether this
  // seat still owes chips to match the current bet.
  return only.committedThisStreet >= state.betLevel;
}
```

Independently, `legalActions` should not offer `bet`/`raise` when no opponent has chips behind,
and should not offer `fold` when `toCall === 0` and betting is closed for the hand.

**Missing test**

- An all-in run-out test that asserts **zero further actions are required**: heads-up, hero
  covers, opponent calls all-in; assert `state.street === 'complete'`, `board.length === 5` and
  `result.showdowns.length === 2` immediately after the calling action, with no further
  `applyAction` calls.
- `assert.deepEqual(legalActions(state, lone), [])` — or at minimum
  `assert.ok(!types.includes('fold') && !types.includes('bet'))` — for the state where one seat
  has chips and every opponent is all-in and covered.
- A property test over the 4,000-hand fuzz harness asserting that no hand ever reaches a state
  where `seatsInHand(state).length >= 2`, exactly one seat is `active`, and that seat is
  `toAct` with its commitment already at `betLevel`.
- A regression test that the best hand wins an all-in: AA vs KK all-in preflop must always pay
  the aces, with no action available that changes it.

---

## P1-3 — The Coach's suggested raise size is below the engine's own minimum legal raise in 21 of 34 shipped scenarios

**Location:** `packages/poker-math/src/coach.ts:250` (`to: input.toCall + option.amount`) and
`coach.ts:290,332-333` (`sizeRange`).

**Problem**

`to` on a raise candidate is meant to be the total street commitment — that is the semantics the
engine's `validateAction` uses when it compares `to` against `minTo`/`maxTo`. The Coach computes
`to = toCall + amount`, which implies hero's existing street commitment is `to − cost = toCall`.
That is true only by coincidence. In the normal case — hero has nothing in this street and faces
a bet — hero's commitment is 0 and the minimum legal raise is `2 × toCall` at least, so
`toCall + amount` is below the minimum for every small rung on the ladder.

`CoachSuggestion.sizeRange.min` is the smallest of these, so the app's headline advice names a
size the server will reject.

**Reproduction**

```
engine minimum raise TO facing a 300 bet with 0 committed = 600
Coach suggested raise to = 433  -> LEGAL? false
legalActions raise bounds: {"type":"raise","minTo":600,"maxTo":2000,"costAtMin":600,...}
```

Across the shipped Scenario Lab, read from the live API (`GET /content/scenarios/:id`):

```
suggested raise size BELOW the engine's minimum legal raise: 21 of 34
  eq-flush-draw-turn-overbet             suggests raise to     360, minimum legal is at least     480 (facing 240)
  eq-rule-of-four-big-draw-flop          suggests raise to     246, minimum legal is at least     340 (facing 170)
  eq-set-on-connected-flop-jam           suggests raise to     230, minimum legal is at least     300 (facing 150)
  rk-counting-the-combos-that-beat-you   suggests raise to     560, minimum legal is at least     960 (facing 480)
  rk-nine-big-blinds-call-or-fold        suggests raise to    9066, minimum legal is at least   12800 (facing 6400)
  rk-when-survival-outweighs-chip-ev     suggests raise to   24000, minimum legal is at least   44000 (facing 22000)
  ... 21 rows
```

**Evidence**

`coach.ts:250` is the whole of it:

```ts
to: input.toCall === 0 ? option.amount : input.toCall + option.amount,
cost: option.amount,
```

`CoachInput` (`coach.ts:54-75`) has no field for hero's existing street commitment, so the
correct `to` is not computable from the Coach's inputs today. The existing test `'every candidate
bet amount is a whole number of chips'` checks `Number.isInteger(candidate.to)` — it verifies the
type of the number, never its legality.

**Fix**

Add `heroCommittedThisStreet: number` and `minimumRaiseTo: number` to `CoachInput` (the caller —
`apps/api/src/calc/parse.ts` and `coachTaskFor` — has both from the engine state), then compute
`to = heroCommittedThisStreet + toCall + raiseBy` and clamp/drop ladder rungs whose `to` is below
`minimumRaiseTo`. Set `cost = toCall + raiseBy`.

**Missing test**

A cross-package test asserting that every aggressive candidate the Coach returns is accepted by
the engine: build a real `HandState`, call `buildCoachReport` from it, then for each candidate
call `validateAction(state, seat, { type: candidate.action, to: candidate.to })` and assert it
does not throw. Run it over all 36 shipped scenarios.

---

## P2-1 — `monteCarloEquity` does not validate `samples`: `NaN` yields a `NaN` equity with a `NaN` interval, `Infinity` hangs the thread forever, and any value ≤ 1 reports a **zero-width** confidence interval

**Location:** `packages/poker-math/src/equity.ts:515` and `equity.ts:210`.

**Problem**

```ts
const samples = Math.max(1, Math.floor(options.samples ?? DEFAULT_SAMPLES));
```

`Math.floor(NaN)` is `NaN` and `Math.max(1, NaN)` is `NaN`, so the trial loop never executes,
`tally.count` is 0, and every division in `toPlayerEquities` produces `NaN`.
`Math.floor(Infinity)` is `Infinity`, so `for (let trial = 0; trial < Infinity; trial++)` never
terminates — in a synchronous loop that no timer or watchdog in the same thread can interrupt.

Separately, `Tally.firstPlayerStdDev()` returns `0` when `trials < 2` (`equity.ts:210`), so a
single-sample run reports a **±0.00-point 95 % interval** — a claim of certainty on one trial.

This matters because every other entry point in the package validates exhaustively and says so
(`odds.ts`: *"Nothing here returns NaN, and nothing is silently clamped"*), and because `equity`
is an exported public API of a package documented as *bounded* Monte Carlo.

**Reproduction**

```
samples=NaN    -> RETURNED trials=0 equity=NaN hw=NaN
samples=-5     -> RETURNED trials=1 equity=0 hw=0
samples=0      -> RETURNED trials=1 equity=0 hw=0
samples=0.4    -> RETURNED trials=1 equity=0 hw=0
samples=1000   -> RETURNED trials=1000 equity=0.299 hw=2.8390165901592055
samples=Infinity -> starting (will be killed by the watchdog if it hangs)...
```

The `Infinity` line never returns. The in-process 6-second watchdog I installed never fires,
because the loop is synchronous — which is itself the proof that nothing inside the worker can
recover from it. I had to `pkill` the process.

**Evidence**

Contrast with every sibling: `probabilityOfHitting`, `ruleOf24`, `potOdds`, `icmEquity`,
`computeOuts`, `projectResults` and `riskOfRuin` all throw a specific typed error on `NaN`,
`Infinity`, negative and out-of-range input — I confirmed 40+ such cases across this review.
`monteCarloEquity` is the one that does not.

**Reachability:** the HTTP path is safe. `packages/contracts/src/schemas.ts:152` constrains
`samples` to `{ type: 'integer', minimum: 1_000, maximum: 500_000 }`, JSON cannot carry `NaN` or
`Infinity`, and `planWork` in `apps/api/src/calc/parse.ts:522` re-clamps with `Math.min`.
`shardCount` is `Math.max(1, …)` so zero-shard requests are impossible too. This is therefore a
library-robustness defect, not an exploitable API hole — hence P2 rather than P1. But it is
reachable from any internal caller, from content tooling, and from the Scenario Lab authoring
path, and the failure mode (a permanently wedged worker thread) is the worst kind.

**Fix**

Validate at the top of `monteCarloEquity`, in the style the rest of the package already uses:

```ts
const requested = options.samples ?? DEFAULT_SAMPLES;
if (!Number.isInteger(requested) || requested < 1) {
  throw new EquityError(
    `samples must be a whole number of at least 1, received ${String(requested)}`,
  );
}
if (requested > HARD_SAMPLE_CEILING) {
  throw new EquityError(`samples must not exceed ${HARD_SAMPLE_CEILING}, received ${requested}`);
}
```

Validate `seed` as an integer for the same reason. And make a sub-2-sample run report its
interval honestly rather than as zero — either refuse `samples < 2`, or return
`halfWidthPoints: null` with a note, mirroring the exact path's deliberate choice of `null` over
"a fabricated 0" (which `coach.test.ts` already asserts for enumeration).

**Missing test**

A hostile-input table in `packages/poker-math/test/index.test.ts` (or a new `equity.test.ts`)
asserting `EquityError` for `samples` of `NaN`, `Infinity`, `-Infinity`, `-5`, `0`, `0.5`,
`Number.MAX_SAFE_INTEGER`, `'1000'` and `null`, and the same for `seed`. Plus an invariant test:
`Number.isFinite(result.players[i].equity)` and
`result.confidence === null || result.confidence.halfWidthPoints > 0` for every result the
function ever returns.

---

## P2-2 — `CoachSuggestion.sizeRange` is the full sizing ladder, not a range of defensible sizes

**Location:** `packages/poker-math/src/coach.ts:290-297` and `332-333`.

**Problem**

```ts
const sameActionSizes = candidates
  .filter((candidate) => candidate.action === best.action && candidate.to !== undefined)
  .map((candidate) => candidate.to ?? 0)
  .filter((value) => value > 0);
...
sizeRange: { min: Math.min(...sameActionSizes), max: Math.max(...sameActionSizes) }
```

The range spans **every** candidate of the chosen action, including the all-in, regardless of how
much worse its EV is. The requirement is for "a suggested action **and size range**"; a range
that always covers the whole ladder carries no information and actively misleads, because it
reads as "anything in here is fine".

**Reproduction**

```
LIVE API, hero 7c2d on AhKdQs, pot 400, toCall 300:
  raise  to=433   ev=     75.624
  raise  to=566   ev=     -2.010
  raise  to=2000  ev=   -839.053
SUGGESTION sizeRange: { "min": 433, "max": 2000 }
```

The suggested range's upper end is a candidate the Coach itself prices at **−839 chips** — 915
chips worse than the lower end. Same shape in the earlier fixture spot: `sizeRange 130–875`
where 875 is priced 65 chips below 130.

**Fix**

Restrict the range to candidates within the indifference margin of the best one (the same
one-big-blind yardstick `buildSuggestion` already uses to downgrade confidence):

```ts
const margin = input.bigBlind;
const sameActionSizes = candidates
  .filter((c) => c.action === best.action && c.to !== undefined && c.ev >= best.ev - margin)
  .map((c) => c.to as number);
```

When only one size qualifies, emit a single value or omit `sizeRange` rather than a spurious span.

**Missing test**

Assert that every `to` inside `suggestion.sizeRange` belongs to a candidate whose EV is within
the margin of the best, and that a candidate priced far below the best (the all-in in the spot
above) is excluded. Also assert `sizeRange.min <= sizeRange.max` and that both are legal raise
sizes per P1-3.

---

## P2-3 — The Coach's candidate EVs have no numeric assertion anywhere in the test suite

**Location:** `packages/poker-math/test/coach.test.ts` (15 tests, all passing).

**Problem**

The coach tests assert *structural* and *relative* properties only: assumptions are non-empty and
are real sentences; a sampled figure carries an interval and an exact one reports `null`; no
string contains "correct"/"optimal"/"GTO"; every `to` is an integer; no candidate costs more than
the stack; a wider range raises equity; the same report is produced twice for the same input.
Not one test compares a candidate's `ev` against a figure derived independently of
`buildCoachReport`. That is precisely why P0-1 has survived: the raise formula could be replaced
with almost anything and all 15 tests would still pass.

The one test whose name suggests it covers the raise path does not exercise it at all — see the
final bullet of P0-1's *Missing test* section.

**Evidence**

```
$ grep -c "^test(" packages/poker-math/test/coach.test.ts
15
$ pnpm run test:unit
packages/poker-math test: ℹ pass 187 / fail 0     (and 591 across all packages)
```

with P0-1, P1-1, P1-2 and P1-3 all live in the code.

**Fix / missing test**

Add hand-computed numeric assertions for `fold`, `check`, `call`, `bet` and `raise` at a fixed
spot with a fixed equity, with the arithmetic written out in the test body as a comment so a
reader can check it without running anything. `ev.ts` and `odds.ts` already do exactly this well
— the pattern just was not carried into `coach.test.ts`.

---

## P3-1 — `poker-ai` re-implements `breakEvenEquity`, against the single-definition rule the maths package states explicitly

**Location:** `packages/poker-ai/src/commentary.ts:398`.

```ts
/** The equity a call needs purely on price. Independent of either hand. */
function breakEvenEquity(potBefore: number, toCall: number): number {
  const denominator = potBefore + toCall;
  return denominator <= 0 ? 0 : toCall / denominator;
}
```

It is currently **arithmetically identical** to `potOdds().breakEvenEquity`, so nothing is wrong
today. But `odds.ts:59-62` states the rule it breaks:

> Prices live in `odds.ts` … so that the package has exactly one definition of each and one place
> to be wrong.

`policy.ts:849` does the right thing and imports `potOdds`. Four call sites in `commentary.ts`
(lines 640, 696, 697, 832) use the local copy, so replay commentary and the Coach panel can
silently disagree after any future edit to either.

**Fix:** delete the local function and import `potOdds` from `@prl/poker-math`, as `policy.ts`
already does.

**Missing test:** a cross-package assertion that the commentary's stated price equals
`potOdds(pot, toCall).breakEvenEquity` for a table of pot/call pairs — plus, more cheaply, a lint
rule or a source-scan test (the repo already has one for `Math.random`) forbidding a second
definition of a named formula outside `odds.ts`.

---

## P3-2 — `packages/contracts` has an empty `test/` directory, and `pnpm test` reports 0 tests as success

**Location:** `packages/contracts/test/` (empty), `packages/contracts/package.json` →
`"test": "node --test 'test/**/*.test.ts'"`.

```
$ ls -la packages/contracts/test/
total 0
drwxr-xr-x@ 2 terence staff 64 17 Aug 19:54 .

$ pnpm run test:unit
packages/contracts test: ℹ tests 0
packages/contracts test: ℹ pass 0
packages/contracts test: ℹ fail 0
exit=0
```

Contracts is the package that defines the API surface, the JSON schemas and the shared types —
including the `samples: { minimum: 1_000, maximum: 500_000 }` bound that is currently the only
thing standing between P2-1 and a wedged worker thread. Nothing verifies it.

**Fix:** either add schema round-trip tests (valid payloads accepted, hostile payloads rejected —
oversized boards, out-of-range sample counts, wrong types, duplicate cards) or remove the empty
directory and the `test` script so a zero-test package cannot be mistaken for a tested one.

**Missing test:** for each exported schema, one accepted fixture and one rejected fixture per
constraint, asserting the specific validation error.

---

## P3-3 — `DEFAULT_ASSUMED_FOLD_EQUITY = 0.35` is a hard-coded probability applied to every aggressive candidate

**Location:** `packages/poker-math/src/coach.ts:77`.

This is *disclosed* — it is reported as `foldEquityAssumed` on every candidate, named in
`whatWouldChangeIt` ("This assumes the line wins uncontested 35 % of the time"), and overridable
via `assumedFoldEquity`. On that basis it does not violate the "no hard-coded odds" guardrail,
and I am not reporting it as one.

It is worth flagging as a design observation, though: applying a fixed 35 % uniformly across
every board, street, bet size and opponent range makes aggression look good almost everywhere.
Combined with P0-1 the Coach recommends `raise` in **34 of 34** shipped scenarios; even after
correcting P0-1 the recommendation is still `raise` in 32 of 34. A coach that always says raise
is not teaching bet-sizing discipline. Consider deriving the default from the profile's modelled
fold frequency (`poker-ai` already has one per Legend), or scaling it with bet size — a 3× overbet
does not win uncontested as often as a third-pot stab.

**Missing test:** a distribution test over the shipped scenarios asserting that the Coach's
recommended action is not the same action in every one of them, and that at least one scenario
with negative equity surplus recommends `fold`.

---

## Could not verify

- **Bot / Legend decision quality and the "no hidden information" property.** I read
  `poker-ai/src/policy.ts` only far enough to confirm it imports `potOdds` from `poker-math`
  rather than re-deriving prices, and that `opponent-model.ts` computes its strength ordering
  from `poker-math` rather than transcribing a chart. The 137 `poker-ai` tests pass. Whether the
  profiles genuinely differ measurably across the 13 required dimensions, and whether any AI path
  can see hidden cards, is Agent D's scope and I did not audit it.
- **Whether the web UI actually renders the `fold` button during an all-in run-out (P1-2).** I
  proved the engine offers it in `legalActions`, and that clients render from that list, but I did
  not drive the browser. If the UI does render it, I would argue P1-2 up to P0.
- **The DB-gated API tests.** `apps/api/test/hands.test.ts:795,904`,
  `repositories.test.ts:679` and `content-routes.test.ts:55` are `skip`-gated on
  `TEST_DATABASE_URL`. I did not check whether that variable is set in CI, so I cannot say
  whether those paths are tested there. Agent A/C scope.
- **`pnpm run test:integration` / `test:smoke` / `db:verify` / `security:audit` / `lint` /
  `typecheck` / `build`.** Out of my scope; not run.
- **Long-horizon Monte Carlo bias below ~0.02 percentage points.** My unbiasedness check has a
  standard error of 0.063 pts at 300 × 2,000 samples. A bias smaller than that would not have
  shown up. Nothing suggests one exists — the estimator is textbook rejection sampling plus a
  partial Fisher–Yates — but I did not run enough trials to exclude it.
- **`combineMonteCarlo`'s between-shard variance term.** The pooled variance is the
  trial-weighted mean of the shards' within-shard variances and omits the between-shard variance
  of the means. For IID shards that term is O(1/n) relative and the combined interval matched a
  single same-n run to 0.1 % empirically, so I judged it correct in practice; I did not derive
  the exact finite-sample bias.

---

## Commands run

```
curl -s http://127.0.0.1:3001/api/v1/health
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/
curl -s http://127.0.0.1:3001/api/v1/auth/session                       # CSRF token + cookie
POST /api/v1/content/quizzes/:id/attempt   x24                          # every numeric question
POST /api/v1/math/coach                                                 # the 7-2 spot above
GET  /api/v1/content/scenarios/:id         x36                          # every shipped scenario
pnpm run test:unit                                                      # 591 tests, exit 0
(cd packages/poker-engine && node --test 'test/*.test.ts')              # 85 pass
(cd packages/poker-math  && node --test 'test/**/*.test.ts')            # 187 pass
(cd packages/poker-engine && node --test --test-timeout=1800000 'test/exhaustive/**/*.test.ts')
```

Plus seven scratch harnesses (odds/EV closed forms; rules and hand evaluation; all-ins, side pots
and a 4,000-hand conservation fuzz; equity, blockers, ties and Monte Carlo; variance, ICM and
stacks; outs; Coach raise-EV derivation and scenario-wide impact) written under
`…/scratchpad/b/`.
