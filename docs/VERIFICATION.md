# Verification

**Last run:** 2026-08-18 · Node 24.18.0 · pnpm 11.10.0 · macOS arm64

Every correctness claim this project makes, and the evidence for it. Where a claim rests on
something weaker than proof, this document says so — a verification record that only lists
its successes is a marketing document.

Timings and counts below were re-measured on the date above. Where a figure is machine-dependent it
says so; where a figure moved because the tests changed, the new one is stated rather than the one
that was easier to keep. **Which of these checks a gate enforces is stated in §12**, because a ✔
that no command produces is a claim, not a result.

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

Measured 2026-08-18: **6.4 s at 20.8 million hands/second** (machine-dependent).

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
generator or the engine changes and the test still passes. They are printed by the run; the numbers
here are the 2026-08-18 measurement, not a target.

The engine's other two soaks, for the same reason: `all-in-runout.test.ts` — **1,500 shove-heavy
hands, 6,847 actions** (1,459 showdowns, 41 fold-outs, 23 run out before any action);
`short-blinds.test.ts` — **3,000 short-blind-heavy hands, 16,156 actions** (2,002 short posts across
1,699 hands, 201 decided by the blinds alone). **8,500 hands and 50,236 applied actions in total**,
which is the figure `REPORT.md` §4 quotes.

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

AA versus KK preflop, averaged over **all 36 suit configurations**:

```
average equity for AA = 81.946%
range across configurations = 81.26% .. 82.64%
```

This matches the widely published ~81.9% figure. The spread also explains a discrepancy that
would otherwise look like a bug: any *single* configuration (AhAd vs KsKc gives 81.26%) sits
away from the published average, because the published figure *is* the average.

Also confirmed: `AKs` vs `22` ≈ 50.08% (a genuine coin flip), `AKo` vs `QQ` ≈ 42.84%, and
Monte Carlo agreeing with exact enumeration to within its stated interval (|diff| 0.095 points
against a ±0.349-point 95% interval).

---

## 9. The teaching content

`packages/content/test/scenarios.test.ts` — **13 tests, all passing**

```
17 lessons · 17 quizzes (80 questions) · 36 scenarios · 90 glossary terms · 11 topics
36/36 scenarios carry claims: 74 independent verification claims, 0 regression locks
```

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

`pnpm run security:audit` — **8 gates, all passing**

| Gate | Result |
| --- | --- |
| Policy in effect | 12 settings asserted against pnpm's *effective* config; `packageManager` integrity-pinned |
| Source encoding | 33+ first-party files: no NUL, no control characters, no bidi/zero-width, valid UTF-8, LF only |
| Denied packages | 0 found across **166 resolved package versions** |
| Dependency shapes | lockfile v9; registry-only resolutions; **0 install-time lifecycle hooks**; every version exact |
| IOC sweep | **10,126 files / 117.3 MiB** swept for 9 string markers, 2 hashes, 4 artefact paths — clean |
| Integrity + release age | **all 162 lockfile hashes match the registry**; every version clears the 7-day cooldown |
| OSV | **0 advisories** across 162 versions |
| SBOM | CycloneDX 1.6, 169 components, 170 dependency records, content-derived serial |

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
| **Bot / profile strength** | Not claimed. The opponent profiles are heuristic teaching styles, explicitly not solver-derived. A strong human should beat all of them |
| **ICM accuracy** | Malmuth–Harville is an approximation ignoring skill, position and blind pressure. Stated with every figure it produces |
| **Risk of ruin** | A diffusion approximation assuming constant edge, constant stakes, normal results and an infinite horizon. Stated every time |
| **Range realism** | Ranges are unweighted sets. Real opponents do not play every hand in a range identically, and the Coach says so in its assumptions |
| **UI component behaviour** | `node --test` cannot render JSX, so only the pure helpers in `@prl/ui` are unit-tested. Component behaviour is checked by the a11y audit and by manual review — stated rather than covered by a shallow-render test that asserts nothing |
| **Accessibility, fully** | The audit is static (server-rendered HTML) because a headless browser needs install scripts the supply-chain policy forbids. It reports exactly what it covers. THREAT-MODEL G5 |
| **Load behaviour at scale** | The harness measures a local dev server, not production capacity, and says so in its output |
| **Container image digests** | Pinned where a digest could be verified at authoring time; otherwise tagged and marked `TODO`. A fabricated digest would be worse than an honest gap |
| **That a test which runs actually asserts anything** | The reachability guard (`apps/api/test/workspace-test-reachability.test.ts`) now proves each package's suite *would execute* tests — a real `node --test` runner, at least one `test()`/`it()` per file, no declaration disabled by a literal skip — but it is a static reader. A test whose body asserts nothing still counts as executing. Closing that needs each package's runner to emit a machine-readable summary a root script asserts on, which is a change to every workspace manifest |
| **Everything outside the gate** | See the table below. A ✔ in this document that no gate reproduces is a result somebody obtained once |

### What the release gate actually enforces

`pnpm run verify` runs eleven gates, reports each, and exits non-zero if any failed. Every section of
this document is mapped onto it here, because "we check that" and "the release checks that" are
different sentences and this project has confused them before.

| This document's claim | Enforced by |
| --- | --- |
| §2.1 five-card enumeration, §3 betting, §4 side pots, §5 whole-hand invariants, §6 hidden information, §7 randomness and commitment, §8 mathematics, §9 content | `test` (via `test:unit`) |
| §2.2 the 133,784,560-hand exhaustive check | `test:exhaustive` — **added to the gate 2026-08-18**; it was in neither `test` nor `verify` before that |
| AI profile axes (`REPORT.md` §7) | `test:simulation` — also added to the gate 2026-08-18 |
| §10 supply chain | `security:audit`, `security:hygiene` |
| The live schema's security properties | `db:verify` — present in the gate before, but as the last link of a `&&` chain, so a failure anywhere earlier skipped it. It had never run inside `verify` |
| Contrast ratios, both themes | `design:contrast` |
| Accessibility, to the extent §12 says it is checked at all | `test:a11y` — **added to the gate 2026-08-18**; it lived only in `test:all`, which is not the gate |
| Everything in the "NOT verified" table above | **Nothing.** That is what the table means |

---

## 13. Reproducing all of it

```bash
pnpm install --frozen-lockfile
pnpm run security:audit        # 8 gates
pnpm run test                  # builds the packages first, then unit + integration + scripts
pnpm run test:exhaustive       # all 133,784,560 seven-card hands (~7 s)
pnpm run test:simulation       # AI profile axes (~2 min)
pnpm run test:a11y
node scripts/check-contrast.mjs   # the design system's contrast claims
```

`build:packages` no longer needs to be a separate step before `test`: `dist/` is `.gitignore`d and
every `@prl/*` package resolves through it, so `test` builds the packages itself rather than testing
whatever build happened to be on disk.

Or in one command: `pnpm run verify`.
