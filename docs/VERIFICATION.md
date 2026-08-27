# Verification

**Last run:** 2026-08-19 · Node 24.18.0 · pnpm 11.10.0 · macOS arm64

Every correctness claim this project makes, and the evidence for it. Where a claim rests on
something weaker than proof, this document says so — a verification record that only lists
its successes is a marketing document.

Timings and counts below were re-measured on the date above. Where a figure is machine-dependent it
says so; where a figure moved because the tests changed, the new one is stated rather than the one
that was easier to keep. **Which of these checks a gate enforces is stated in §12**, because a ✔
that no command produces is a claim, not a result.

> **Why the counts in this document are re-run rather than carried forward.** The release audit
> found that §5's coverage figures had been wrong through several changes without anything
> noticing, because those assertions are *floors* (showdown > 200, side pots > 100, …) and a test
> that keeps passing while its documented numbers drift is a document nobody re-derives. §7 claimed
> 19 tests in a file that has 10; §8 claimed 25 identity checks over a 19-row table; §10's gate
> count was one short. Every figure below was re-measured on 2026-08-19 by running the command
> named beside it, and the ones that move are labelled as measurements rather than as targets.

---

## 1. The principle

An app that teaches probability has one unforgivable failure: **being confidently wrong.**

So the foundations are checked against **ground truth the code has no access to** — published
combinatorial results, closed-form identities, and independent reimplementations — rather than
against themselves. A test that asserts a function returns what that function returns is a
regression lock, not verification, and this document keeps the two labelled.

---

## 2. The hand evaluator

### 2.1 Every five-card hand — 2,598,960 of them

`packages/poker-engine/test/evaluate.test.ts`

Two independent checks over the complete enumeration:

1. **Against a deliberately different implementation.** `test/reference-evaluator.ts` sorts
   ranks, counts runs with plain arrays, and compares tuples — a completely different
   algorithm from the production evaluator's integer bit-lanes. Both classify all 2,598,960
   hands identically. An error would have to exist in both, in the same place, in the same
   direction.
2. **Against published frequencies.** The category counts match the known combinatorial
   result exactly:

| Category | Expected | Got |
| --- | --- | --- |
| High card | 1,302,540 | ✔ |
| One pair | 1,098,240 | ✔ |
| Two pair | 123,552 | ✔ |
| Three of a kind | 54,912 | ✔ |
| Straight | 10,200 | ✔ |
| Flush | 5,108 | ✔ |
| Full house | 3,744 | ✔ |
| Four of a kind | 624 | ✔ |
| Straight flush | 40 | ✔ |

Runtime: **1.9–2.1 s** for the exhaustive comparison across repeated runs (machine-dependent, and
quoted as a range because two consecutive runs here differed by 12%); the whole
`packages/poker-engine/test/evaluate.test.ts` — 15 tests — is ~2.5 s.

### 2.2 Every seven-card hand — all 133,784,560

`packages/poker-engine/test/exhaustive/seven-card-distribution.test.ts` ·
`pnpm run test:exhaustive`

The strongest single check in the project. Every seven-card hand in the deck is enumerated and
classified, and the nine category counts match the published result **exactly**:

| Category | Expected | Got |
| --- | --- | --- |
| High card | 23,294,460 | ✔ |
| One pair | 58,627,800 | ✔ |
| Two pair | 31,433,400 | ✔ |
| Three of a kind | 6,461,620 | ✔ |
| Straight | 6,180,020 | ✔ |
| Flush | 4,047,644 | ✔ |
| Full house | 3,473,184 | ✔ |
| Four of a kind | 224,848 | ✔ |
| Straight flush | 41,584 | ✔ |
| **Total** | **133,784,560** | ✔ |

Measured 2026-08-19: **6.5 s at 20.6 million hands/second**, whole suite 6.6 s, 2 tests
(machine-dependent; the same measurement on 2026-08-18 gave 6.4 s / 20.8 M/s, which is the run-to-run
spread rather than a change).

**Why this is strong.** A single misclassified hand moves at least two counters. The sum is
independently checked against C(52,7). And the frequencies were derived mathematically long
before this code existed, so matching them cannot be circular.

**And it is now gated.** This check was in neither `test` nor `verify` — it lived only in
`test:all`, which is not the release gate — so the ✔ above was a result somebody had produced once,
not a result the release procedure reproduces. An audit correctly marked it UNVERIFIED for that
reason. `test:exhaustive` is now one of `verify`'s gates; at 7 seconds there was never a good
argument for leaving the strongest single check in the project outside the gate.

### 2.3 Ordering, not just classification

Category agreement does not prove kicker ordering, so:

* **200,000 random pairs** of five-card hands compared for relative order against the
  reference. Zero disagreements.
* **20,000 random seven-card hands** checked against brute force over all C(7,5)=21 subsets,
  confirming "picks the best five". Zero disagreements.
* `straightHigh` checked **exhaustively over all 8,192 rank masks** against a naive scan —
  this is what pins the wheel (A-2-3-4-5 is the *lowest* straight) and confirms the ace does
  not wrap around (K-A-2-3-4 is not a straight).
* `popCount13` checked exhaustively over all 8,192 masks.

---

## 3. The betting engine

`packages/poker-engine/test/betting.test.ts` — **19 tests**

Covers: blind posting; the big blind's option; heads-up blind reversal (button posts the small
blind, acts first preflop and last afterwards); minimum raise by *increment* rather than
doubling; short all-ins; ante accounting; out-of-turn rejection; over-stack rejection;
non-integer and NaN rejection; and chip conservation.

### Two real bugs these tests found

Recorded because finding them is the evidence the tests are worth having.

**1. A raiser could immediately re-raise its own raise.** `lastActedAtBetLevel` recorded the
bet level *before* the action, so for a raiser it stayed below the level the raiser had just
created — and `mayRaise` (`lastActed < lastFullRaiseBetLevel`) therefore returned true. Fixed
by recording the post-action level. The test that catches it is
*"a player who raises cannot raise again until someone else raises"*.

**2. Antes were treated as live bets.** Adding the ante to `committedThisStreet` made the
opening bet level `ante + bigBlind`, which silently broke every call amount at the table.
Antes are now dead money: they increase `committedTotal` (so side pots are right) and go
straight to the pot, but never touch `committedThisStreet`.

---

## 4. Side pots

`packages/poker-engine/test/pots.test.ts` — **11 tests**

Covers three-way all-ins with distinct amounts, folded contributors, uncalled-bet return,
layer merging, split pots, and deterministic odd-chip assignment left of the button.

**5,000 randomised all-in shapes** — mixed statuses and commitments — asserting that pot
layers plus returns always equal total commitments, that no folded seat is ever awarded chips,
and that nobody receives back more than they put in.

### A design gap this found

The fuzz produced a state where the **single largest contributor had folded**, leaving a pot
layer with no eligible winner. The original code threw mid-settlement. Legal play cannot reach
that state — you cannot fold chips nobody matched — but throwing halfway through paying out a
hand is a far worse failure mode than the alternative. `buildPotLayers` now caps contributions
at the highest amount any *live* seat committed and returns the excess to its contributor,
which is also what a dealer does. The function is now total.

---

## 5. Whole-hand invariants

`packages/poker-engine/test/invariants.test.ts`

**4,000 randomised hands, 27,233 actions.** Random seat counts (2–6), stacks (deliberately
including stacks smaller than the blinds), blind structures, antes, button positions and
action choices. After **every single action**, it asserts:

* chips are conserved exactly;
* no card is dealt to two places;
* the bet level agrees with the seats' commitments;
* pot layers balance;
* `toAct` points at an active seat that has legal actions;
* board size matches the street;
* all-in seats have no chips behind;
* on completion: awards equal the pots, the hand's own commitment reveal verifies, and nobody
  lost more than they committed.

Coverage achieved: 3,385 hands reached showdown, 615 ended by folding, **2,945 produced side
pots**, 123 were all-in before the flop. A fuzz run that never reaches the interesting states
tests nothing, so those counts are themselves asserted — as *floors* (showdown > 200, folds > 200,
side pots > 100, every street reached), which is why the exact figures above move when the
generator or the engine changes and the test still passes. **That is precisely how the previous
numbers here (32,245 actions; 3,518/482/3,114/31) stayed wrong through several changes**: the
assertions are floors, so the suite went on passing while the document drifted. They are printed by
the run; the numbers here are the 2026-08-19 measurement, not a target, and the line to trust is
the one the run prints:

```
$ node --test 'test/invariants.test.ts'
      4000 hands, 27233 actions | showdown 3385, folded 615, side pots 2945, all-in preflop 123
```

The engine's other two soaks, for the same reason: `all-in-runout.test.ts` — **1,500 shove-heavy
hands, 6,847 actions** (1,459 showdowns, 41 fold-outs, 23 run out before any action);
`short-blinds.test.ts` — **3,000 short-blind-heavy hands, 16,156 actions** (2,002 short posts across
1,699 hands, 201 decided by the blinds alone). **8,500 hands and 50,236 applied actions in total**,
which is the figure `REPORT.md` §4 quotes. That report once claimed **20,000 hands / 167,987
decision points** for this soak; no such run exists. The only `20_000` anywhere in the tree is a
seed-collision check in `packages/poker-ai/test/stats.test.ts`, which asserts that 20,000 hands of
heads-up play derive 60,000 distinct decision-stream seeds — a different claim about a different
thing.

Two further properties:

* **Determinism** — the same seed reproduces board, commitment, action log and payouts
  exactly.
* **Rejection is total** — every illegal action leaves the state **byte-identical**. This
  matters more than rejecting: a partially-applied rejection is a corruption nobody notices.

---

## 6. Hidden information

`packages/poker-engine/test/hidden-information.test.ts` — **11 tests**

Checked at runtime, not by code review. Every view for every recipient at every point in a
hand is serialised and scanned for cards that recipient must not see, plus the deck, the
cursor and the salts.

Confirmed: an opponent's hole cards are never present during play; a spectator sees none; the
undealt deck never appears; cards are revealed only at showdown and only for seats that
actually showed; **a hand that ends by folding reveals nobody's cards**; legal actions are
offered only to the player whose turn it is.

### The security flaw this found

The first commitment design was `SHA-256(salt ‖ deck)`, published before the deal and revealed
afterwards. A hidden-information test failed, correctly: **revealing the deck reveals all 52
cards**, including the hole cards of everyone who folded without showing. Heads-up, a fold
would publish the winner's exact hand.

The integrity control would have created a confidentiality leak worse than the problem it
solved. Replaced with a per-card Merkle tree that proves only the cards which legitimately
became public. See [ADR 0004](adr/0004-merkle-deck-commitment.md) and
[THREAT-MODEL](THREAT-MODEL.md) T2.

The general lesson, worth keeping: **an integrity mechanism can create a confidentiality
hole, and the two have to be designed together.**

---

## 7. Randomness and the commitment

`packages/poker-engine/test/rng.test.ts` (**10 tests**) ·
`test/commitment.test.ts` (16 tests)

**Randomness**

* `Math.random` does not appear in engine code — checked by a comment-stripping source scan,
  and the scan has its own test proving it can fail.
* Rejection sampling verified: the wrap value is consumed and discarded rather than folded, and
  a generator stuck in the rejection region raises instead of returning biased output.
* 520,000 draws over 52 values: chi-squared **well under** the 99.9th-percentile threshold
  (99.6 with 51 degrees of freedom).
* **All six orderings of three items occur within 5% of uniform** over 120,000 shuffles. This
  is the test that catches the classic Fisher–Yates bug (drawing from `[0, n)` instead of
  `[0, i]`), which produces a measurably lopsided distribution.
* The deterministic test generator refuses to run under `NODE_ENV=production`.

**Commitment**

Every attack the scheme exists to stop is tested and rejected: substituting a card at a
revealed position; moving a card to a different position; tampering with a salt; tampering
with a proof path; replaying a reveal under a different context; claiming the same card at two
positions; revealing a position twice. Plus: an unrevealed position leaks nothing, salts are
verified to be a full 32 bytes, and identical decks with different salts produce different
roots.

---

## 8. The mathematics

**19 independently-derived identity checks**, verified directly — several of the rows carry more
than one value, so the number of asserted equalities is higher, and it is the rows that are counted
here rather than an aggregate nobody can reproduce. Every one was computed by hand or from a closed
form, not read off the implementation:

| Check | Expected | Result |
| --- | --- | --- |
| A pot-sized bet lays the caller | exactly 1/3 | ✔ |
| A half-pot bet lays the caller | exactly 1/4 | ✔ |
| `breakEvenEquity(100, 50)` | exactly 1/3 | ✔ |
| MDF + alpha | exactly 1 | ✔ |
| `MDF(100, 50)` | exactly 2/3 | ✔ |
| P(hit 9 outs, 1 card, 47 unseen) | 9/47 | ✔ |
| P(hit 9 outs, 2 cards, 47 unseen) | 1 − (38/47)(37/46) | ✔ |
| EV of call at break-even equity | exactly 0 | ✔ |
| EV of call at equity 0 / 1 | −toCall / +pot | ✔ |
| EV of bet at fold probability 1 | exactly pot | ✔ |
| `requiredFoldEquity` round-trip through `evOfBet` | 0 | ✔ |
| `breakEvenBluffFrequency(100, 50)` | 1/3 | ✔ |
| `breakEvenBluffFrequency(100, 100)` | 1/2 | ✔ |
| `normalCdf(0)` / `(1)` / `(1.959964)` | 0.5 / 0.8413447 / 0.975 | ✔ |
| Mean scales linearly, deviation as √n | ×2 and ×√2 | ✔ |
| Risk of ruin | `exp(−2·B·wr/sd²)` | ✔ |
| Risk of ruin at zero win rate | exactly 1 | ✔ |
| ICM, 3:1 stacks, 70/30 payouts | exactly 60 / 40 | ✔ |
| ICM, equal stacks | prizePool ÷ n exactly | ✔ |

The **EV-of-call-at-break-even identity is the most valuable single check here**: it ties
`ev.ts` to `odds.ts`, so the two modules cannot drift apart without a test failing.

### Equity, checked against a published result

AA versus KK preflop, averaged over **all 36 suit configurations**. Re-derived 2026-08-19 by
enumerating every configuration through `exactEquity`, 1,712,304 boards each:

```
configurations enumerated: 36
boards per configuration: 1,712,304
average equity for AA = 81.946%
min 81.26%  (AhAd vs KcKs)
max 82.64%  (AcAs vs KcKs)
```

This matches the widely published ~81.9% figure. The spread also explains a discrepancy that
would otherwise look like a bug: any *single* configuration sits away from the published
average, because the published figure *is* the average.

Two neighbouring figures, stated as averages this time because that is what they are — this
document previously gave the **extreme** configuration for each and set it beside the AA-vs-KK
*average*, which reads as an average and is not one:

| Matchup | Configurations | Average | Range | Previously stated |
| --- | ---: | ---: | --- | ---: |
| `AKs` vs `22` | 24 | **49.89%** | 49.70% – 50.08% | 50.08% *(the maximum)* |
| `AKo` vs `QQ` | 72 | **43.24%** | 42.84% – 43.65% | 42.84% *(the minimum)* |

`AKs` vs `22` is still the genuine coin flip it is described as; `AKo` vs `QQ` is 0.4 points
better for the AK than this document used to say.

Monte Carlo agrees with exact enumeration inside its own stated interval. Measured 2026-08-19
on AhAs vs KdKc (exact 81.255%), 20,000 samples, three seeds: |diff| 0.455 / 0.100 / 0.050
points against 95% half-widths of ±0.544 / ±0.540 / ±0.538 — inside all three. A single seed
proves less than it looks like it proves, which is why three are quoted.

### And all of it is now reproduced by a gate

`packages/poker-math/test/equity-published-figures.test.ts` — inside `test`, so inside `verify`.
**Every one of the 132 configurations above is enumerated on every run**, 1,712,304 boards each,
by a second implementation written for this file: five nested loops over the remaining 48 cards
and nothing else, deliberately sharing none of `exactEquity`'s machinery. 25 s, measured
2026-08-26.

What it asserts, beyond the three averages and their extremes:

* **The suit-isomorphism structure.** Suits are interchangeable in hold'em, so configurations
  that differ by a relabelling of the four suits must have *bit-identical* equity. That forces
  the multiplicity profile — 6/24/6 for AA-vs-KK, 12/12 for AKs-vs-22, 12/24/24/12 for
  AKo-vs-QQ — and an evaluator with any suit-dependent behaviour splits a class and changes
  those counts even if the average survives. Asserted on the raw floats, not on rounded strings.
* **`exactEquity` agrees with the longhand enumerator to the last bit** on one configuration from
  each matchup. The two are tied together by equality, not by a tolerance.
* **Monte Carlo against exact enumeration, with the tolerance derived from the sample size and
  not chosen.** 200 seeds × 20,000 samples, each bounded by *its own* 95% half-width
  (1.96·sd/√n, computed by `monteCarloEquity` from the variance it observed): 184 of 200 intervals
  contained the exact value where ~190 is expected, worst single miss 1.66 half-widths. Then all
  200 shards pooled through the production `combineMonteCarlo` — 4,000,000 samples against a
  ±0.038-point interval, landing 0.016 points out. Seeds are fixed, so a 95% interval cannot
  flake a gate; what the fixed seeds cost is generality, which is why the assertions are about the
  ensemble rather than about any one run.
* `apps/api/test/calc.test.ts`'s AA-vs-KK bound, which used to be `> 0.8 && < 0.84`, is now
  `|x − 0.81255489679402726| < 1e-9`. The old window was four percentage points wide on a figure
  whose entire spread across all 36 configurations is 1.4.

**Negative controls, each run.** With `popCount13(suitC) >= 5` changed to `>= 6` in the evaluator
— club flushes silently stop existing — the AA-vs-KK average moves to 82.098% and the test fails;
**the old 0.80–0.84 bound accepts it**. With ties scored as losses in `Tally.record`, the
production/longhand equality fails at 0.81065 against 0.81255. With the interval's `1.96` changed
to `1.0`, coverage falls to 138 of 200. With the Monte Carlo run-out pool short by one card, the
pooled 4,000,000 samples land 0.1335 points out against their own ±0.0382.

Two things this does *not* prove, recorded because the row above them used to overclaim: the
longhand enumerator shares `evaluate` with production, so it is independent of the equity code and
not of the evaluator — what pins the evaluator is the constants, which are published results and
§2's exhaustive enumeration. And 132 configurations is every configuration of *these three*
matchups, not of hold'em.

---

## 9. The teaching content

`packages/content/test/scenarios.test.ts` — **13 tests, all passing**

```
17 lessons · 17 quizzes (81 questions) · 36 scenarios · 90 glossary terms · 11 topics
36/36 scenarios carry claims: 74 independent verification claims, 0 regression locks
```

*(This said **80** questions until 2026-08-26. `contentStats()` says 81 and prints it on every run;
the figure was another one nobody re-derived, which is the whole subject of the note at the top of
this document.)*

### What is verified

* **Every scenario's teaching claim is checked against the computed maths.** All 74 claims are
  *qualitative* — `equityExceedsBreakEven`, `breakEvenExceedsEquity`, `callEvSign`,
  `cleanOutsEquals` — which makes them genuine independent verification: a human asserted a
  teaching point and the maths confirms it. A scenario whose point stops being true fails the
  build.
* Every scenario is **playable**: legal distinct cards, board length matching the street,
  coherent pot arithmetic, a non-empty opponent range after blockers.
* Every range **parses under the real grammar** — which deliberately rejects ambiguous
  notation like `T9s+`, so a scenario cannot silently mean something its author did not intend.
* **No computed number is stated as prose fact** anywhere in scenarios, lessons or quizzes.
  Hedged approximations are permitted, since the rule of 2 and 4 is itself a lesson.
* **No gambling or dark-pattern language**, checked mechanically against a phrase list: real
  money, cash-out, currency symbols, streaks, guarantees, loss-chasing, and the phrase
  "correct play".
* **No pass/fail or score-threshold language** in any quiz.
* Numeric quiz questions ask for a field their calculation can actually produce — with the
  valid field names **derived by running each calculation**, not from a hand-written list.
* Scenarios span the syllabus: no topic exceeds 40% of the set. Distribution: pot-odds 6,
  equity 6, outs 5, position 4, rules 3, sizing 3, fold-equity 2, ranges 2, variance 2,
  tournaments 2, psychology 1. By difficulty: 6 intro, 16 core, 14 advanced.
* Analysis is **deterministic for a given seed**, so every learner sees the same numbers.

### The other kind of number, and the gap it sat in

`packages/content/test/taught-figures.test.ts` — **2 tests**, added 2026-08-26.

Everything above is about *computed* figures: an equity, a price, an out count, produced at
runtime and never stored. That rule left a whole class untouched — the arithmetic a lesson
**works through**, which a learner is meant to follow line by line. "13 pairs at six each, which
is 78." "The next raise must therefore reach at least 100, not 80 and not 120." "The short
stack's chance of finishing first is 100/400 = 25%, so they take 25% of first plus 75% of second:
0.25×70 + 0.75×30 = 40." None of that is a computed figure dressed as prose; it *is* the
teaching, and nothing checked it.

Two halves:

* **27 registered claims, recomputed.** Each names a record and quotes the sentence, and each
  value the entry compares is DERIVED — the 1,326 combinations from `allHandClasses()` and from
  C(52,2); the minimum raise from a hand actually dealt through `startHand`/`applyAction` and
  read off `minimumRaiseTo`; the 60/160 side pots from `buildPotLayers`; the 60/40 prize equity
  from `icmEquity`; the wheel's rank and the category ladder from `evaluate`. A quote that no
  longer appears **exactly once** fails as loudly as a wrong number, because a registry entry
  that stops matching is a guard that stopped guarding. 66 derived values are matched back into
  the prose.
* **A mechanical sweep of all 61 live calculations and numeric quiz questions**, comparing 112
  graded inputs against the prose around them. The failure it exists for is an edit to one side
  only — a prompt reworded to "the pot stands at 120" over the `{ pot: 100 }` the learner is
  marked against. For the rule of 2 and 4 it compares the *multiplier the prose names* against
  `cardsToCome`, which is worth more than the digits: a caption reading "the rule of 4" over a
  one-card calculation teaches the wrong shortcut while every number on the page still agrees.

Prose that deliberately omits a number — "the identical bet", "same edge and same standard
deviation, but with three times the bankroll" — is an explicit table of exemptions, each naming
the phrase that earns it and why, and **an exemption that fires for nothing fails the test**.

**Negative controls, each run on 2026-08-26.** `1326` → `1327` in the lesson, `60` → `50` in the
side-pot answer, `100` → `90` in the minimum-raise chain: all three fail. A quiz prompt changed to
"the pot now stands at 120" while `potOdds` is still graded on 100: fails. A caption still reading
"one card left to come" over a `cardsToCome: 2` calculation: fails, naming the multiplier. And in
the other direction, with the content untouched and `combosOfClass` made to drop one offsuit
combination, the 1,326 chain fails — the entry is tied to the code, not to a second copy of the
answer.

### What the audit of 2026-08-26 found

Every numeric claim in `packages/content`, in the Coach's generated prose, and in the
hand-written prose of `apps/web/src/fixtures/**` was decided against computation. **One was
wrong**, in the fixture the live table falls back to when the API is unreachable:

> `apps/web/src/fixtures/table.ts`, under "what would change it":
> *"A cutoff who folds far less often than 35% to a flop raise. **Below roughly 20% the raise
> and the call are worth about the same.**"*

Measured through `evOfRaise` and `evOfCall` on the report's own inputs — pot 100, 35 to call,
raise to 105, 54.1% equity — at 20% fold equity the raise is **17.0 chips ahead** of the call,
not level with it, and solving for the frequency at which they meet gives **−10.2%**: there is
no fold frequency at or above zero at which the claim is true. With equity above an even share
the raise beats the call against an opponent who never folds, because more units in the middle
at better than half the pot is worth more than the folds. The sentence gave a learner a
threshold that does not exist, and told them to fold out of a line that was ahead by 5.7 chips
at worst. It now states the real quantities — 0.56 chips per point of fold equity, 5.7 ahead at
zero, 17.0 ahead at 20% — and the crossover that *does* exist, which is 50% **equity** and not
a fold frequency at all. `apps/web/test/table-fixture-figures.test.ts` recomputes all of it,
and asserts the shape too: the fixture may name a fold-equity threshold only if solving for one
gives a non-negative answer.

The file's own header derives most of its figures by hand, and **every figure it derives is
right**. The one that was wrong is the one the header does not derive, which is the argument
for the guard in one line.

Three further figures are rounded teaching approximations and are left, each because the text
that carries them says so: "a small pair flops a set about one time in eight" (exactly 11.755%,
one in 8.51, and the same scenario's reasoning states 11.8% two paragraphs later); "each unseen
card is roughly one in fifty" (47 on the flop, and the lesson names 47 in the sentence before);
and the rule of 2 and 4 itself, whose inaccuracy is the lesson. One more figure was wrong in
this document rather than in the product: §9 said 80 quiz questions where `contentStats()` says
81.

### Content defects these checks found

Six blocking defects were found and fixed during review, including: a `callEvSign: positive`
claim in a spot where the price is zero (so EV of calling is exactly 0 and the claim could
never hold); a title asserting "one clean out" where the engine counts three; an assumption
stating hero's kicker "can never outrank" another ace when the stated range contains a hand it
does outrank; and a range label describing "second pairs" on a board where those hands make
sets.

Each was found by *running the real analyser*, not by reading.

### One thing this is not

A `cleanOutsEquals` claim requires an **exact** opponent hand; the validator rejects it against
a range, because against a range the out count depends on which hand is held. That restriction
is enforced rather than documented.

---

## 10. Supply chain

`pnpm run security:audit` — **15 gates**. Figures below are from the run of 2026-08-19 and
were copied out of that run's output, not carried forward, **except the rows that carry their
own later date**, which were re-captured because the gate list had grown and the pinning
figures had gone stale. This section said "9 gates" for both reasons at once: `secret-scan` and
`container-scan` had been added to the `GATES` array and no row here named them.

| Gate | Result |
| --- | --- |
| Policy in effect | 12 settings asserted against pnpm's *effective* config; `packageManager` integrity-pinned |
| Source encoding | 444 first-party source files: no NUL, no control characters, no bidi/zero-width, valid UTF-8, LF only. Plus 200 files across **8 `src/` trees** scanned for `Math.random`. *The two file counts moved to 451/202 within the same afternoon as other work landed — read the gate's own line; the number worth asserting is the **8 trees***|
| Denied packages | 0 found across **162 resolved package versions** (104 on disk; 58 are platform-skipped optional deps, inspected from the registry by the integrity gate) |
| Dependency shapes | lockfile v9; 162 resolutions and 49 importer edges; registry-only; **0 install-time lifecycle hooks** across 104 installed manifests; every version exact |
| IOC sweep | **10,540 files / 125.4 MiB** swept for 9 string markers, 2 hashes, 6 artefact paths — clean |
| Committed credentials | *2026-08-25:* **621 tracked files read** of 622 tracked; 7 secret-bearing paths checked against the ignore rules. Working tree only — `--history` is opt-in and is not part of the audit |
| CI + container pinning | *2026-08-25:* **3 workflows, 46 action references** all 40-hex commit SHAs; 2 Dockerfiles with 2 external base images and **3 compose files with 8 image references**, all `@sha256:` digests; no undeclared workflow. (Was recorded as 2 workflows / 24 actions / 1 compose file / 2 images, measured 2026-08-19) |
| Integrity + release age | **all 162 lockfile hashes match the registry**; every version clears the 7-day cooldown |
| OSV | **0 advisories** across 162 versions |
| Pinned action advisories | *2026-08-27:* **63 action references over 4 distinct pins in 4 repositories**, each resolved to the version it is by `git ls-remote --tags` — v7.0.1, v7.0.0, v7.0.1, v6.0.0, every one agreeing with its trailing comment — matched against **55** published `GitHub Actions` advisories from OSV: **0 findings**. Its 6 built-in controls behaved on the same run |
| SBOM | *2026-08-25:* CycloneDX 1.6, **170 components, 171 dependency records**, content-derived serial |
| Container image CVEs | trivy at the HIGH floor against the built release images. Not run by a commit-time audit — on a checkout with no release images the gate reports **not applicable** and the summary says so. Last measured against the candidate digests 2026-08-24 (trivy 0.72.0): **0 blocking, 60 unfixable, 0 allowed**; see `docs/production/staging-verification.md` for the CRITICAL/HIGH breakdown |

The eight-gate figure this table used to give is what the pinning gate was added to fix: the
repository's *own* dependencies were held to "no mutable references" by six gates, while the
**pipeline's** dependencies — GitHub Actions and container base images — were held to it by
header comments. `uses: actions/cache@v4` added tomorrow would have passed all eight, and that
is a pointer its owner can repoint at code which then runs here with this repository's secrets.

`--offline` skips *integrity + release age*, *OSV*, *pinned action advisories* and *container
image CVEs* — **four** gates, not the two this paragraph used to name and not the three it named
after that — and then **exits 2** rather than 0, because an audit that did not run four of its
gates has not passed and a pipeline reading only the exit code could not previously tell the
difference. The advisory gate skips only under that flag: run on its own with no network it
**fails**, because an advisory database that cannot be reached makes every pinned action unknown,
and unknown is not clean. The container gate is skipped rather than reported
not-applicable under `--offline` because `audit.mjs` tests the offline branch first, which is
what makes the run exit 2 instead of 0 on a machine that has no release images either way.

### Pinning is not safety, and for a while nothing here said so

`ci-pinning.mjs` proves every `uses:` is a full commit SHA, which stops a tag being repointed. It
says nothing about a pinned SHA of a version an advisory was later published against — that stays
pinned, and stays vulnerable, silently and for ever. `action-advisories.mjs` closes it, and two
measurements against the live services on 2026-08-27 decided how:

* OSV's **version-qualified** query returns `{}` for the `GitHub Actions` ecosystem even for a
  version squarely inside a published range (`canonical/get-workflow-version-action` 1.0.0 against
  an advisory covering everything below 1.0.1), while the same query with no `version` key returns
  the advisory and the identical shape against `npm` returns six. The ecosystem is real — a garbage
  one is rejected with `invalid ecosystem`. A gate built the way `osv-scan.mjs` is built would have
  queried successfully, matched nothing, ever, and printed a green tick over an empty answer.
* OSV's **name** query is case-sensitive and GitHub's `uses:` is not: `Azure/setup-kubectl` returns
  GHSA-p756-rfxh-x63h and `azure/setup-kubectl` returns `{}`.

So the gate downloads the ecosystem's whole published corpus (one request, 55 records) and indexes
it case-insensitively — which also lets it assert its advisory source is non-empty, something a
per-name query cannot do.

The version comes from GitHub, never from the `# v7.0.1` comment: a gate whose answer comes from a
comment is turned green by editing the comment. `git ls-remote --tags` gives the tags at a commit,
peeled `^{}` line included, and the most specific one is the release — `v7` and `v7.0.1` both point
at the pinned checkout commit and reading `7` as a version too would make every advisory fixed
inside the current major fire against a pin that is not affected. The comment is checked *against*
that answer, so a mislabelled pin is its own failure.

Eight failure modes, each demonstrated by running the real gate against the real repository with one
deliberate defect at a time on 2026-08-27:

| Defect | What the gate did |
| --- | --- |
| one `actions/download-artifact` pin moved to `f44cd7b4…` — real commit, real release v4.1.0, real advisory | ✗ `GHSA-cxww-7g56-2vh6 affects actions/download-artifact@4.1.0 severity=HIGH`, exit 1 |
| the correct `actions/checkout` SHA relabelled `# v9.9.9` | ✗ *actions/checkout is labelled `# v9.9.9` and GitHub says that commit is v7, v7.0.1*, exit 1 |
| `actions/checkout` pinned to the head of `main` — a real commit no tag names | ✗ `no tag of actions/checkout points at the pinned commit`, exit 1 |
| every HTTP request sent to a dead proxy | ✗ `the GitHub Actions advisory corpus could not be read`, exit 1 |
| `git` alone sent to a dead proxy | ✗ `could not read the tags of actions/download-artifact`, exit 1 |
| the action-reference floor raised to 64 | ✗ `found 63 action reference(s); this gate refuses to run below 64`, exit 1 |
| the advisory-corpus floor raised to 999 | ✗ `the advisory corpus holds 55 record(s)`, exit 1 |
| `actions/upload-artifact` pinned to a real SHA that belongs to `actions/checkout` — a copy-paste swap | ✗ *no tag of actions/upload-artifact points at the pinned commit 3d3c42e5aac5*, exit 1 |

The first is the one that matters: a real, published, HIGH advisory against a real version of an
action this repository really uses, found from the SHA rather than from the label beside it.

### A finding worth recording

**pnpm 11 reads only auth and registry settings from `.npmrc`.** A policy written there —
`ignore-scripts`, `minimum-release-age` — is silently ignored, and the repository looks
hardened while being wide open.

That is why the policy gate does not read a file: it asks pnpm for its *effective*
configuration and asserts on that, and separately **fails** if a policy key appears in
`.npmrc` at all. A setting sitting where it is ignored is worse than one that is absent,
because it reads as protection.

Note also that **npm provenance attestations are recorded but not trusted as a control** — the
Mini Shai-Hulud campaign forges them. 65 of 162 packages carry one; the gate does not care.

---

## 11. Two defects found in tooling, not product code

Both are recorded because they are the kind of thing that survives review.

1. **A NUL byte inside a template literal** in `scripts/supply-chain/lib.mjs`. Invisible in
   every editor and in `git diff`; the file still parsed and ran; it silently changed a map key
   separator. This is why `security:hygiene` exists — and the gate then immediately caught a
   second instance of the same class (literal ESC bytes where escape sequences were intended).
2. **A false positive in the content validator**: an exact opponent range legitimately restates
   that seat's own hole cards, which the duplicate-card check read as a duplicate. Fixed by
   comparing the range against each seat's holding before treating its cards as additional —
   so a genuine error (an exact range naming cards nobody holds) is still caught.

---

## 12. What is NOT verified

The honest section.

| Claim | Status |
| --- | --- |
| **The deck is chosen fairly** | **Not verified, and not verifiable by this design.** The commitment proves the deck was *fixed before any action*, not that it was *chosen* honestly. A dishonest operator could grind candidate decks and commit to a favourable one. Closing it needs player-contributed entropy. THREAT-MODEL G1 |
| **The web app would render a leak** | **Not covered, deliberately.** Hole-card redaction has ONE boundary — `redactFor` on the server. `apps/web`'s `isSeatView` accepts `holeCards` on any seat and `Seat.tsx` draws them face-up, so a leaking API would be rendered faithfully. The three "a card the server hid stays hidden" tests in `a11y-contracts.test.ts` are regexes over SOURCE TEXT and only ask what happens when `holeCards === null`; **no test in `apps/web` would fail if the API leaked.** Adding client-side redaction would be a second boundary and a product change, not a guard — recorded here rather than done. Found by the hidden-information sweep, 2026-08-27 |
| **`audit_log`'s forbidden-key CHECK is narrower than it looks** | It is top-level, byte-exact and camelCase-only, so `hole_cards`, `cards`, `board` and `reveal` all pass the database constraint. The app-layer scrub now catches the first via a substring pattern; the other three pass both layers. No call site carries one today, and widening the CHECK needs a new migration. Same sweep |
| **A card stringified into a log message** | `scrubValue` returns strings verbatim, so `log.info({ note: JSON.stringify(state) })` passes every layer. Not fixable by a key denylist, and not currently done anywhere. Same sweep |
| **`PostgresError.detail` carries the failing row** | ~~Not pinned.~~ **Closed 2026-08-27.** It arrives as `Failing row contains (…, ["Ah","Ks"], …)` on an enumerable own property, and was safe only because `serializeError` reads a FIXED field set of five and postgres.js `debug` is never enabled — both true by construction and asserted by nothing. `apps/api/test/log-error-fields.test.ts` now pins the field set exactly, pins that the message and code still survive so it is redaction rather than silence, and refuses a `debug:` option in `db.ts` or `sql.ts`, whose callback receives every statement and its parameters |
| **Bot / profile strength** | Not claimed. The opponent profiles are heuristic teaching styles, explicitly not solver-derived. A strong human should beat all of them |
| **ICM accuracy** | Malmuth–Harville is an approximation ignoring skill, position and blind pressure. Stated with every figure it produces |
| **Risk of ruin** | A diffusion approximation assuming constant edge, constant stakes, normal results and an infinite horizon. Stated every time |
| **Range realism** | Ranges are unweighted sets. Real opponents do not play every hand in a range identically, and the Coach says so in its assumptions |
| **UI component behaviour** | `node --test` cannot render JSX, so only the pure helpers in `@prl/ui` are unit-tested. Component behaviour is checked by the a11y audit and by manual review — stated rather than covered by a shallow-render test that asserts nothing |
| **Accessibility, fully** | The audit is static (server-rendered HTML) because a headless browser needs install scripts the supply-chain policy forbids. It reports exactly what it covers. THREAT-MODEL G5 |
| **Load behaviour at scale** | The harness measures a local dev server, not production capacity, and says so in its output |
| **Container image digests** | *Presence* is now verified and gated: every base image and every GitHub Action is `@sha256:`/40-hex pinned and `ci-pinning` fails the release otherwise (2026-08-19). What is **not** verified is that any pinned artefact was benign when its digest was taken — a digest pins bytes, not trustworthiness. This row used to say digests were partly absent; that is no longer true, and it is recorded here rather than deleted |
| **A pinned digest staying safe** | **Half true, and the half that was wrong was disproved here on 2026-08-26.** The OSV gate does query the `npm` ecosystem only. But the container CVE gate inside `security:audit` runs trivy against the built images, and trivy reads the Alpine package database — so an advisory against the OS packages a pinned base image ships is caught automatically, at the gate, without anybody reading a feed. That is exactly how **CVE-2026-14456** (HIGH, OpenSSL, in the `node:24.18.0-alpine3.24` digest's libcrypto3/libssl3 3.5.7-r0) surfaced: four findings across both images, release-blocking, hours after they were built. The same used to be false of a pinned **GitHub Action**, and since 2026-08-27 it is not: `action-advisories` — gate twelve of `security:audit` — resolves every one of the 63 pinned SHAs to the version it is by asking GitHub which tags point at that commit, and matches those versions against OSV's published `GitHub Actions` advisory corpus. It does not read the `# v7.0.1` trailing comment for the answer; it checks the comment against the answer, so a mislabelled pin fails too. A pinned SHA that no tag names, an unreachable corpus and a corpus that arrives short all fail rather than pass — see `scripts/supply-chain/action-advisories.mjs` for the two measurements that decided the design, and §10 for the eight demonstrated failure modes |
| **The backup and restore procedure** (`RUNBOOK` §11.4) | Rehearsed by hand on 2026-08-19 — dump, `migrate.mjs roles`, `pg_restore --exit-on-error`, `db:verify` exit 0, `db:migrate:status` exit 0 — and **enforced by nothing**. No gate restores a dump. `db:verify` runs inside `verify` against the *development* database, which proves the checks work, not that a restore produces a database they would pass |
| **Who owns schema `prl`** | **Now checked.** It was not, and that gap was found by breaking it: `verify-schema.mjs` check 6 asserts `prl_app` owns no relation and holds no `CREATE`, but never asked who *did* own the schema. Restoring a dump as `prl_api` without `--exit-on-error` leaves all relations in `prl` owned by `prl_api` — which then holds `CREATE` and can `DROP` every table it serves — and `db:verify` exited **0** over it. Check 6b now asserts `pg_namespace.nspowner` and every `pg_class.relowner` in `prl` is `prl_migrator`. It earned its place immediately: on first run it failed the shared development database, whose migration ledger was still owned by the bootstrapping superuser, and `pnpm run db:migrate` repaired it. |
| **That `up` actually calls the destructive-statement gate** | The gate's logic is well covered — `apps/api/scripts/migrate.test.mjs`, 10 tests, run inside `test:scripts`: `down` refuses without a database, the scanner fires on each destructive kind, ignores a `DROP` that is only mentioned in prose, catches one hidden in a `DO` block, and rejects a bare `-- prl:irreversible:` with no reason. What no test covers is the **wiring** — that `up` consults it before applying — because that needs a live database and a deliberately-bad pending migration |
| **That a test which runs actually asserts anything** | The reachability guard (`apps/api/test/workspace-test-reachability.test.ts`) now proves each package's suite *would execute* tests — a real `node --test` runner, at least one `test()`/`it()` per file, no declaration disabled by a literal skip — but it is a static reader. A test whose body asserts nothing still counts as executing. Closing that needs each package's runner to emit a machine-readable summary a root script asserts on, which is a change to every workspace manifest |
| **§8's headline equity figures** | **Closed 2026-08-26**, and the row is kept rather than deleted because what it said was true for as long as it stood. `packages/poker-math/test/equity-published-figures.test.ts` enumerates all 132 suit configurations of the three published matchups on every `verify`, asserts the averages, the extremes and the suit-isomorphism multiplicities, ties `exactEquity` to a second implementation bit-for-bit, and measures 4,000,000 Monte Carlo samples against exact enumeration inside an interval derived from the sample size. `apps/api/test/calc.test.ts`'s 0.80–0.84 window — the reason this row existed — is now 1e-9. See §8 |
| **Teaching prose outside the registry** | `packages/content/test/taught-figures.test.ts` recomputes 27 named claims and sweeps all 61 live calculations against the prose around them, which is 112 graded inputs. It cannot decide a sentence nobody registered. The hand-written prose in `apps/web/src/fixtures/table.ts` and `legends.ts` in particular is checked by nothing: unlike `scenarios.ts` and `review.ts`, whose analysis blocks `fixtures:check` regenerates, those two are baked demo copy end to end. Every figure in them was decided by hand on 2026-08-26 and none was wrong; nothing reproduces that |
| **Everything outside the gate** | See the table below. A ✔ in this document that no gate reproduces is a result somebody obtained once |

### What the release gate actually enforces

`pnpm run verify` runs **sixteen** gates, reports each, and exits non-zero if any failed. Every
section of this document is mapped onto it here, because "we check that" and "the release checks
that" are different sentences and this project has confused them before. (This said *eleven*, then
*thirteen*, then *fourteen*, then *fifteen*: eleven was the count before `test:ax` and `test:csp`
joined the loop in `package.json`, thirteen was right until `test:age-gate` joined it, fourteen until
`test:layout` did, and fifteen until `test:keyboard` did. Read the count off that loop, not off this
sentence. Nothing in the table below maps onto
`test:age-gate` — it enforces a control this document makes no claim about, and
`docs/production/legal-review-requirements.md` follow-up 5 is where it is described.)

| This document's claim | Enforced by |
| --- | --- |
| §2.1 five-card enumeration, §3 betting, §4 side pots, §5 whole-hand invariants, §6 hidden information, §7 randomness and commitment, §8 mathematics, §9 content | `test` (via `test:unit`) |
| §2.2 the 133,784,560-hand exhaustive check | `test:exhaustive` — **added to the gate 2026-08-18**; it was in neither `test` nor `verify` before that |
| AI profile axes (`REPORT.md` §7) | `test:simulation` — also added to the gate 2026-08-18 |
| §10 supply chain | `security:audit` (fifteen gates, including `ci-pinning` since 2026-08-19, `secret-scan`/`container-scan` since, `image-provenance`, `log-policy` and `keyless-signing-identity` since 2026-08-25, and `action-advisories` since 2026-08-27), `security:hygiene` |
| The roll-forward-only migration policy (`RUNBOOK` §11.3) | `test` (via `test:scripts` → `apps/api/scripts/migrate.test.mjs`). The scanner is gated; the wiring into `up` is not — see the table above |
| The hand-typed Coach report in `apps/web/src/fixtures/table.ts`, which `fixtures:check` does not reach | `test` (via `test:unit` → `apps/web/test/table-fixture-figures.test.ts`). Every figure in it recomputed from `@prl/poker-math` on the report's own inputs: the price, the rule-of-2-and-4 error against `probabilityOfHitting`, the interval against its own trial count, both expected values against `evOfCall`/`evOfRaise`, the SPR, and the out counts. **Added 2026-08-26 because it found a wrong one** — see §9 |
| The counts the product prints about itself — lessons, topics, glossary terms, scenarios, claims | `test` (via `test:unit` → `apps/web/test/product-counts.test.ts`), against `contentStats()` and the bundle. Added 2026-08-26 for the reason §9 records: the same class of figure had already drifted inside this document |
| That `apps/web/src/fixtures/**` still equals what the engine computes | `test` (via `test:integration` → `apps/api/test/web-fixture-figures.test.ts`). `pnpm run fixtures:check` is the operator-facing form of the same computation and `pnpm run fixtures:regenerate` is the remedy — which the repository did **not** contain until 2026-08-18, which is how a rule-of-2-and-4 estimate of `1.6` shipped and rendered as "160.0%" |
| The live schema's security properties | `db:verify` — present in the gate before, but as the last link of a `&&` chain, so a failure anywhere earlier skipped it. It had never run inside `verify` |
| Contrast ratios, both themes | `design:contrast` — three passes: the token set, the pairings a component may use, and the **composited background of every element carrying text**, walked in real Chrome on every route in both themes (and under `prefers-reduced-transparency` and `prefers-contrast: more`). The third needs the web app **built** and a Chrome on `CHROME_PATH`; without either it fails rather than skipping |
| §8's AA-vs-KK / AKs-vs-22 / AKo-vs-QQ figures, and Monte Carlo agreeing with exact enumeration | `test` (via `test:unit` → `packages/poker-math/test/equity-published-figures.test.ts`). **This row said "Nothing" until 2026-08-26.** All 132 suit configurations enumerated per run by a second implementation, ~25 s; the averages, the extremes, the multiplicity profile forced by suit isomorphism, `exactEquity` tied to the longhand path by bit equality, and 200 × 20,000 Monte Carlo samples measured against the enumeration inside their own 95% half-widths |
| §9's teaching prose — the arithmetic a lesson works through, as opposed to a computed figure | `test` (via `test:unit` → `packages/content/test/taught-figures.test.ts`). 27 registered claims, each recomputed from `@prl/poker-engine` or `@prl/poker-math` and required to appear verbatim in the record it names; plus a sweep of all 61 live calculations and numeric quiz questions comparing 112 graded inputs against the prose a learner reads. Deliberate omissions are an explicit table with reasons, and **an exemption that fires for nothing fails the test** |
| Accessibility, to the extent §12 says it is checked at all | `test:a11y` — **added to the gate 2026-08-18**; it lived only in `test:all`, which is not the gate |
| That the primary journeys can be driven with a keyboard alone | `test:keyboard` — real `Input.dispatchKeyEvent` through Chrome's own input pipeline on every route: tab order against the focusable set, focus visibility under `:focus-visible` measured focused against blurred, no trap, the skip link, the modal sheet's trap and its Escape, the bet-size slider under the arrow keys, and one whole hand opened, sat down at, dealt and folded from the keyboard at a live socket-backed table. **Added to the gate 2026-08-26**; before that it was in no gate and no workflow, because it had no `--start` and needed a person to bring up two servers first. 146 checks on 2026-08-26 |
| That the app's text does not paint over itself, escape its column or get cut off | `test:layout` — `Range.getClientRects()` over every text node, every route, both themes, at 360/768/1024/1440/1920, in real Chrome. It measures the GLYPHS: the defect it was written for was a grid track that collapsed to 0px, where the element boxes do not overlap and the text does. Six injected negative controls run before the sweep — one per check it can report, the first of them the offending CSS rule put back verbatim — and each must be caught. This document made no claim about layout before it, which is the point — the defect shipped past every row above |
| Everything in the "NOT verified" table above | **Nothing.** That is what the table means |

---

## 13. Reproducing all of it

```bash
pnpm install --frozen-lockfile
pnpm run security:audit        # 15 gates
pnpm run test                  # builds the packages first, then unit + integration + scripts
pnpm run test:exhaustive       # all 133,784,560 seven-card hands (~7 s)
pnpm run test:simulation       # AI profile axes (~2 min)
pnpm run test:a11y
pnpm run fixtures:check        # web fixtures still equal what the engine computes
pnpm run build                 # design:contrast measures the BUILT web app, in real Chrome
pnpm run design:contrast       # the design system's contrast claims, and what a reader sees
```

`build:packages` no longer needs to be a separate step before `test`: `dist/` is `.gitignore`d and
every `@prl/*` package resolves through it, so `test` builds the packages itself rather than testing
whatever build happened to be on disk.

Or in one command: `pnpm run verify`.
