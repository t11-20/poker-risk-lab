# Agent F — AI Opponents & Educational Correctness

**Reviewer:** independent (did not write this code) · **Date:** 2026-08-18
**Scope:** `packages/poker-ai/`, `docs/AI-LEGENDS.md`, the bot boundary in `apps/api/`, the Coach
(`packages/poker-math/src/coach.ts`, `outs.ts`, `variance.ts`), and `packages/content/` — lessons,
quizzes, glossary and the 36 Scenario Lab scenarios.

**Status: FAIL** — one P0, two P1, six P2, nine P3.

The `poker-ai` package itself is the strongest part of this repository that I looked at. The
information boundary holds under instrumentation I wrote myself, the profiles are measurably and
significantly different, the policies are genuinely probabilistic and deterministic per seed, no
LLM or network call exists anywhere in the decision path, decision quality is provably
outcome-independent, and every scenario claim and Coach figure I recomputed from scratch matched.

The P0 is not in `poker-ai`. It is that the entire AI Legends section of the shipped web app never
reaches the API, so it renders a bundled fixture that hard-codes `namingMode: 'attributed'` — which
means the product currently displays six real people's names on every page load with
`PRL_LEGEND_NAMING` unset, bypassing the one guardrail the whole naming design exists to enforce.

---

## What I ran

```
(cd packages/poker-ai && node --test 'test/*.test.ts')                     → 137/137 pass
(cd packages/poker-ai && node --test --test-timeout=1800000 'test/simulation/**/*.test.ts')
                                                                           → 18/18 pass, 110s
(cd packages/content  && node --test 'test/**/*.test.ts')                  → 13/13 pass
(cd packages/poker-ai && tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json) → clean
(cd apps/api && node --test 'test/bots.test.ts')                           → 7/7 pass
node_modules/.bin/biome ci .                                               → 0 errors, 2 warnings
curl -s http://127.0.0.1:3001/api/v1/health                                → {"status":"ok",...}
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/              → 200
```

Plus four throwaway probe suites I wrote and have since deleted (a full-`PolicyInput` recording
Proxy; my own 4,000-hand × 12-profile sweep at my own seed with my own two-proportion z-test; a
mixing/calibration probe across all 12 profiles × 3 difficulties; a `decisionQuality`
outcome-independence and hostile-input probe), and two standalone verification scripts using **my
own** card parser, 5-of-7 evaluator, range expander and exhaustive enumerator — nothing from
`@prl/poker-math` or `@prl/poker-engine` — to recompute scenario equity, break-even, EV and
clean/dirty outs from first principles.

---

## 1. Can a policy see hidden information? — **NO. Verified independently.**

`PolicyInput` (`packages/poker-ai/src/policy.ts:246-256`) takes `view: PlayerView`, `holeCards`,
`seat`, `traits`, `difficulty`, `observations`, `random`. There is no `HandState`, so no `deck`,
`deckCursor` or `deckSalts` is representable.

The shipped `test/no-hidden-information.test.ts` wraps only `input.view` in a recording Proxy. I
wrapped **the whole `PolicyInput`**, all seven keys including `observations`, recursively, and
walked complete hands: **12 profiles × {2, 3, 6} seats × 6 seeds = 1,267 real decisions** covering
preflop, flop, turn and river. Recorded read set, numeric indices collapsed to `#`:

```
PROBE decisions=1267 streets=preflop,flop,turn,river
PROBE distinct collapsed paths (71):
  difficulty  difficulty.adaptationEnabled  difficulty.equitySamples  difficulty.noise
  holeCards  holeCards.#  holeCards.length
  observations  observations.adjustmentsFor  observations.rangeFor  observations.statsFor
  random  random.nextInt  seat
  traits.<all sixteen axes>
  view.actions[.#.action.type|.#.seat|.#.street]  view.amountToCall  view.betLevel
  view.board[.#|.length]  view.buttonSeat  view.config.bigBlind  view.config.maxSeats
  view.legalActions[.#.maxTo|.#.minTo|.#.type]  view.potTotal
  view.seats[.#.committedThisStreet|.#.position|.#.seat|.#.stack|.#.status]
  view.street  view.toAct  view.viewerSeat
PROBE forbidden-path reads: NONE
PROBE card-position reads checked: 89964
```

No `deck`, no `deckCursor`, no `deckSalts`, no `salt`, no `result`, no `commitmentRoot`, and — the
stronger claim — **no `holeCards` path on any seat of the view**, not even the policy's own. The
seat's cards arrive only through `input.holeCards`. 89,964 card-bearing numeric reads were checked
against the engine's own `cardsHiddenFrom(state, seat)`; none was a hidden card.

The API boundary holds too. `apps/api/src/rooms/bots.ts` never touches a `HandState` except in
`buildHypotheticalState`, which builds a throwaway state for the "compare profiles" spot and
immediately redacts it. `buildPolicyInput` (`bots.ts:266`) takes a `PlayerView` and nothing else and
reads the seat's own cards out of `view.seats[...].holeCards`. The runner re-reads
`table.viewFor(botUserId)` after the thinking delay and submits through `LiveTable.submitAction`,
the same path a human uses. The opponent model is fed only `TableNotice.publicActions` (a type with
no card field) and the bot's own completed `PlayerView`, whose `result.showdowns` holds only hands
actually turned over.

**No P0 here. I looked hard and found nothing.**

## 2. Are the profiles measurably different? — **YES. Verified with my own simulation and z-test.**

I ran my own 4,000-hand-per-profile heads-up sweep at seed 6,180,339 (the shipped suite uses
20,260,817 and 8,000 hands) and wrote my own pooled two-proportion z-test from the formula:

```
MYSWEEP id                            vpip d/o     pfr d/o     agg d/o     bluff d/o   3bet d/o
vocal-aggressor              0.32/0.341  0.23/0.259  0.66/0.541  0.34/0.408  0.48/0.329
adaptive-exploiter           0.28/0.318  0.23/0.276  0.68/0.559  0.42/0.438  0.66/0.335
patient-technician           0.25/0.280  0.21/0.252  0.64/0.469  0.36/0.320  0.56/0.280
reading-pressure-specialist  0.42/0.444  0.34/0.373  0.74/0.631  0.46/0.513  0.70/0.451
old-school-pressure          0.38/0.402  0.30/0.329  0.72/0.613  0.40/0.493  0.55/0.401
mixed-game-generalist        0.34/0.371  0.24/0.281  0.62/0.528  0.44/0.417  0.58/0.322
volume-grinder               0.36/0.391  0.30/0.350  0.70/0.580  0.48/0.470  0.78/0.417
disciplined-specialist       0.15/0.168  0.14/0.160  0.52/0.332  0.18/0.212  0.44/0.165
foundational-reader          0.30/0.311  0.19/0.206  0.56/0.500  0.36/0.368  0.40/0.251
range-narrator               0.40/0.431  0.26/0.296  0.60/0.484  0.38/0.351  0.50/0.301
fundamentals-coach           0.23/0.255  0.18/0.206  0.55/0.395  0.28/0.244  0.45/0.224
calling-station              0.52/0.511  0.07/0.070  0.16/0.134  0.08/0.090  0.08/0.058

MYSWEEP z(VPIP calling-station 1592/3114 vs disciplined-specialist 523/3114) = 28.603
MYSWEEP z(aggression extremes)                                              = 39.920
```

Both clear the α = 0.001 two-sided critical value of 3.2905 by an order of magnitude. VPIP and PFR
track their declared values inside the documented 0.05 tolerance on every profile, and the
declared-vs-observed VPIP rank correlation is ρ = 1.0000 in the shipped suite. The shipped suite
also reports 61 of 66 pairs separating on VPIP alone at α = 0.001 and names the five that do not.

Two real drifts fall out of this, both below (see P2 findings 6 and 7): **every one of the twelve
profiles is measurably LESS aggressive and LESS 3-bet-happy than its own card claims**, and nothing
in CI asserts on either axis.

## 3. Probabilistic, not scripted? — **YES, for every profile at every difficulty.**

I put each of the 12 profiles into 40 real dealt spots and asked for 200 decisions per spot with
200 different seeds, at all three difficulties:

```
MIX realistic    disciplined-specialist       mixed 18/40 spots
MIX realistic    calling-station              mixed 31/40 spots
MIX expert       range-narrator               mixed 31/40 spots
… (every one of 36 profile × difficulty combinations mixed in 18–31 of 40 spots)
```

The unmixed spots are hopeless or trivially free holdings, which is correct behaviour, not a script.
I then compared the sampled frequency against the policy's own published pre-sampling distribution
over 2,000 trials per profile at the first genuinely mixed spot:

```
CALIB foundational-reader          call   observed 0.1895 declared 0.2130 = 2.57 sigma
CALIB mixed-game-generalist        raise  observed 0.6275 declared 0.6527 = 2.37 sigma
CALIB entries beyond 4 sigma: 0
```

The sampler draws from the distribution it publishes.

## 4. Determinism — **holds.**

Same seed reproduces the action, the distribution, the equity assessment and every word of the
reasoning (shipped `test/no-hidden-information.test.ts` and my own probe); a 750-hand run reproduces
byte-identical statistics; and the invisible-card-swap test proves the decision does not move when a
card the policy cannot see changes. The draw order is fixed (equity seed, then one jitter per
bet/raise candidate, then the sampling draw), so a replay cannot drift.

## 5. Impersonation — **the package is clean; the shipped web app is not (P0).**

In `poker-ai` the controls are real and layered: `assertNoImpersonation` runs at module load over
every authored profile string (so an impersonating profile cannot be imported), and again at
generation time on every `rationale`, every `whatChangedIt` entry and `modelPreference` before
`decide` returns. `commentary.ts` adds a second guard with a person-name check derived from
`PROFILES` itself, a ban on all human and first-person pronouns, a verdict-word ban
(`correct/optimal/mistake/wrong/gto/solved/…`), a ban on the caller-supplied identity label
verbatim, and a case-sensitive ban on the acting seat's own card tokens. `LearnerFacing` is a
branded string with exactly one mint site. `profileDisclosure` returns the display name and its
disclaimers in the same object with no function that returns a name alone, and
`ProfileDisclosureDto.disclaimers` is a required non-empty array on the wire.

The disclaimers do render. On the live `/legends` page the universal disclaimer appears 26 times and
the attribution disclaimer 18 times; the profile page's `h1` is the archetype name with the
attributed name beneath it, never the other way round.

But the naming default is **not** archetype in the delivered product. See P0.

## 6. Strategy quality vs outcome — **provably separated.**

`scoreDecisionQuality` takes exactly `{ analysis, chosenAction, bigBlind }`. There is no parameter
capable of carrying a run-out, a winner or a chip result. I scored the same decision inside
`buildHandComparison` against `chipResult: +500` and `chipResult: -500`, and against an empty board
versus `As Ks Qs`:

```
QUALITY input keys: analysis, chosenAction, bigBlind — no chipResult, no winner, no board run-out
QUALITY same quality for +500 and -500: band=slightly-off evGivenUp=-7
```

`deepEqual` on the two `decisionQuality` objects passes. `evGivenUp` is `chosen.ev - best.ev` where
`best` is the max over candidates including `chosen`, so it can never be positive. `chipResult` and
`decisionQuality` are assembled independently and meet only in `outcomeVersusQualityNote`, which
exists to say out loud that they disagree and never explains one by the other. When nothing could be
scored, the aggregate is zero with a note saying it carries no information and the
outcome-versus-quality note is suppressed — the false-congratulation path is closed. Hostile input:
`bandForShortfall(NaN|Infinity|-1)` throws, `bigBlind` of 0/-1/NaN/Infinity throws, an unpriced
action throws with a message telling the caller to check `analysisEvaluatedAction` first, and a
`NaN` candidate EV throws rather than producing a band.

## 7. No LLM in the loop — **confirmed.**

`packages/poker-ai/src/` imports exactly four modules: `@prl/contracts`, `@prl/poker-engine`,
`@prl/poker-math`, and its own files. Grep for `fetch(`, `http`, `WebSocket`, `XMLHttpRequest`,
`node:http`, `undici`, `axios`, `openai`, `anthropic`, `gpt`, `llm`, `net.`, `dns.`,
`child_process`, `exec(` across `src/` returns only the string `'Phil Hellmuth'` (matching "http" in
"Hellmuth"), the word "https" in a doc comment, and `pattern.exec(text)` in the impersonation guard.
`Math.random` appears nowhere in any package's `src/` — only in comments saying it is banned.

## 8. Coach correctness — **the numbers are right; the sizes are not (P1).**

I recomputed three real spots from scratch with my own exhaustive enumerator and evaluator:

| spot | my equity | Coach | my break-even | Coach | my EV(call) | Coach | my clean outs | Coach |
|---|---|---|---|---|---|---|---|---|
| `9h8h` on `Kh 5h 2c` vs `KdQs` | 37.98% | 37.98% | 23.81% | 23.81% | +14.88 | +14.879 | 9 | 9 |
| `AhKs` on `Qd 8c 3h` vs `AdQc` | 14.04% | 14.04% | 29.63% | 29.63% | −21.05 | −21.045 | 3 | 3 |
| `AhQs` on `Qh Th 5h 8s 3c` vs a 50-combo range | 68.00% | 68.00% | 33.33% | 33.33% | +499.20 | +499.20 | n/a | n/a |

Exact, to every digit the Coach prints. The rule-of-2/4 figure is reported *with its actual signed
error* ("understating by 2.0 points here — 36% against an exact 38.0%"), the method and trial count
are always named, an exact enumeration reports `confidenceInterval: null` rather than a fabricated
zero, `assumptions` is non-empty and throws if it ever were, and there is no field in
`CoachSuggestion` capable of expressing certainty. `whatWouldChangeIt` is always populated and names
the fold-equity assumption as an input rather than a measurement. `riskOfRuin` and `projectResults`
also reproduce my arithmetic exactly (see §11).

The defect is the *size* attached to a raise. See P1 finding 2.

## 9. Content correctness — **seven scenarios verified end to end; all seven hold.**

Content stores situations, never answers. `expectedInsight` claims are checked against live maths at
test time, and `scenario-analysis.ts` honestly separates *verification* claims from *regression
locks*. The suite reports `36/36 scenarios carry claims: 74 independent verification, 0 regression
locks` — so every claim in the shipped content is a real check.

I verified seven scenarios with my own code, parsing the situation, expanding the range notation
myself, and enumerating every remaining board:

```
### eq-flush-draw-turn-small-bet (turn)   62 combos  pot=145 toCall=25 breakEven=14.71%
  MY equity 26.80% over 2728 exact run-outs · MY EV(call) +20.55 → both claims true
### eq-flush-draw-turn-overbet (turn)     62 combos  pot=360 toCall=240 breakEven=40.00%
  MY equity 26.80% · MY EV(call) −79.22 → both claims true
### eq-dominated-flush-draw-turn (turn)   exact KdQd  pot=125 toCall=55 breakEven=30.56%
  MY equity 20.45% · MY EV(call) −18.18 · MY clean outs 9 (3c 3h 3s 5c 5h 5s 6c 6h 6s) → all true
### fl-flush-draw-counting-outs (flop)    exact KdQs  breakEven=23.81%
  MY equity 37.98% · MY clean outs 9 → all true
### fl-open-ended-straight-draw-outs      exact KsQh   MY clean outs 8 → claim cleanOutsEquals 8 ✓
### fl-gutshot-facing-turn-bet            exact KdQs   MY clean outs 4 → claim cleanOutsEquals 4 ✓
### fl-overcards-dirty-outs (flop)        exact AdQc  breakEven=29.63%
  MY equity 14.04% · MY clean outs 3 (Kc Kd Kh) → all true
### rk-counting-the-combos-that-beat-you  50 combos  pot=960 toCall=480 breakEven=33.33%
  MY equity 68.00% · MY EV(call) +499.20 → both claims true
```

The prose is true of the situations too. I hand-audited
`rk-counting-the-combos-that-beat-you`: the range yields exactly six makeable heart flushes
(`9h8h 8h7h 7h6h Jh9h KhJh 4h3h`), one `QQ`, three `TT`, three `55` and three off-suit `J9` straights
= 16 combinations that beat `AhQs`, and 50 − 16 = 34 = 68.0%. `KQ` makes only one pair with a king
kicker, which loses to hero's ace kicker — the scenario's reasoning is right that "an unexamined fear
of 'they could have a flush' usually falls apart" on combination counting. In
`eq-dominated-flush-draw-turn` the nine clean outs are the three non-diamond treys plus the six
pairing cards, exactly as I computed, and the seven remaining diamonds are correctly excluded because
they complete the opponent's higher flush.

The range notations parse to what they claim: my independent expander produced the same combination
counts the app's `parseRange` does (e.g. 62 combos for the turn flush-draw range after removing hero
and board blockers), and the shipped test `every scenario range parses under the real grammar` covers
all 36.

## 10. Hard-coded numbers — **essentially clean.**

No numeric quiz stores an answer. All 24 `numeric` questions carry a `calculation` spec plus a
`field`, `unit` and `tolerance`; the union of their keys is
`kind, id, prompt, calculation, field, unit, tolerance, explanation` — there is no `answer`,
`correct` or `expected` field anywhere. The 54 `multipleChoice` questions do carry `correctIndex`,
which is legitimate: they ask about rules and definitions, not computed figures. The two `decision`
questions delegate to a scenario id.

I scanned every string in every content file for numeric prose facts of forms the shipped test does
*not* check (`N to 1` odds ratios, `one in N`, bare decimals like `0.35`, `N percent`). Three hits,
all correctly hedged and all true: "roughly one in fifty", "roughly one in fifty", "close to one in
fifty, which is about two percent". Two lesson `keyTakeaways` and one quiz explanation.

Worth noting for whoever maintains that test: `no scenario states a computed figure as prose fact`
only matches `\d+%`, despite its own comment claiming it also catches "'x in y' style odds
statements", and its 60-character look-behind whitelists a figure whenever any of
`roughly|about|approximately|around|rule of|order of|near|circa|ballpark|for example|say` appears
anywhere in it. It is weaker than it reads. It happens to pass honestly today.

## 11. Educational usefulness — **strong, with two real inconsistencies (P2 findings 8 and 9).**

**Variance and risk of ruin are excellent.** Every figure is a live calculation from stated
assumptions, and both lessons lead with the assumptions rather than burying them. I verified the
arithmetic independently:

```
projectResults(wr=5, sd=100, hands=10000):  E=+500bb  SD=1000bb  95% [-1460, +2460]  P(loss)=30.85%
  mine:  100 blocks × 5 = 500 · √100 × 100 = 1000 · 500 ± 1.96×1000 · Φ(-0.5) = 0.3085   ✓
projectResults(wr=5, sd=100, hands=250000): E=+12500  SD=5000    95% [+2700, +22300]  P(loss)=0.62%
  mine:  2500 × 5 · √2500 × 100 · 12500 ± 9800 · Φ(-2.5) = 0.00621                      ✓
riskOfRuin(B=1000, wr=3, sd=90) = 0.47676062866896984 · mine exp(-6000/8100) = 0.476761  ✓
riskOfRuin(B=3000, wr=3, sd=90) = 0.108368 · riskOfRuin(B=1000, wr=9, sd=90) = 0.108368  ✓
```

The lesson's claim that tripling the edge and tripling the bankroll buy identical risk reduction is
exactly right — both give an exponent of −2.2222. `riskOfRuin` returns eight explicit assumptions
and a full derivation from Brownian motion with drift, including the units cancelling. The lesson
states five assumptions and says of each that it makes the real risk *higher* than the number
shown, which is the honest direction.

**The ICM lesson is honest as an approximation.** "ICM is a model with strong assumptions, not an
oracle. It ignores position, blind levels, the fact that some players are better than others…
Quote the shape, not the decimal." A key takeaway repeats it: "trust its direction, not its
decimals." A callout states plainly that no money, prizes or transferable value exist and that a
payout schedule appears "only as arithmetic to reason about". No P-level finding.

**The clean/dirty outs distinction is taught — but the product carries three incompatible
definitions of it, and in the flagship teaching example the app contradicts the lesson.** See P2
findings 8 and 9.

**Guardrails:** the content suite asserts no gambling or dark-pattern language, no score threshold
or pass/fail language in quizzes, and that scenarios span the syllabus. Nothing in the material I
read makes a claim of optimality, and the Coach panel's own label is "One reading of this spot".

---

# FINDINGS

## P0

### F1 — The whole AI Legends UI serves a bundled fixture that forces attributed real-person names on, bypassing the `PRL_LEGEND_NAMING` opt-in

**Location:** `apps/web/src/lib/legends-data.ts:47-52` (`LEGEND_API_PATHS`) against
`apps/api/src/app.ts:55` (`API_PREFIX = '/api/v1'`); consequence in
`apps/web/src/fixtures/legends.ts:651` (`namingMode: 'attributed'`) and `:186-202`
(`attributedDisclosure` → `displayName: '<real name> (modelled style)'`, `attributed: true`).

**Problem.** Every Legends request the web app makes is missing the `/v1` segment, so it 404s and
`loadLegendProfiles` / `loadLearnFromProfile` fall through to the bundled fixture. That fixture
deliberately ships `namingMode: 'attributed'` — its own header comment explains this was chosen
because "the permissive mode … is the harder case to render correctly". The result is that the
production web app, with `PRL_LEGEND_NAMING` unset and the API healthy, renders real people's
names as profile identities on every page load. Three further consequences ride along: only 8 of
the 12 profiles are shown (the fixture says so itself: "Eight of the twelve profiles the server
ships"), so the required roster is not delivered; the compare page and the hand-review page render
sample analyses; and the "observed" panel shows invented statistics (F3).

`docs/AI-LEGENDS.md` §2 is explicit that this is the guardrail that matters: "**The safe mode is
the default, because the mode you get by not thinking about it should be the safe one.** … Setting
the variable is the moment to consider name, image and likeness permissions." §12 L11 makes it a
deployer decision with legal consequences. Nothing was set, and the names are shown anyway.

**Reproduction.**

```
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/legends/profiles
404
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/v1/legends/profiles
200
$ curl -s http://127.0.0.1:3000/legends > /tmp/legpage.html
$ grep -o "profile service is not reachable[^\\\"]*" /tmp/legpage.html | head -1
profile service is not reachable, so this page is rendering the bundled sample profiles. The
trait values and the disclaimers are real; treat nothing here as a live figure.
(That lesson, quiz or scenario does not exist.)
$ for n in Hellmuth Ivey Seidel Chan Deeb Glaser Brunson Negreanu; do
    echo "$n: $(grep -o $n /tmp/legpage.html | wc -l)"; done
Hellmuth: 2
Ivey: 2
Seidel: 2
Chan: 4
Deeb: 2
Glaser: 2
Brunson: 0
Negreanu: 0
$ grep -o 'modelled style' /tmp/legpage.html | wc -l
14
$ for p in /legends /legends/compare /legends/hand-review /legends/patient-technician; do
    curl -s http://127.0.0.1:3000$p | grep -c "not reachable"; done
1
1
1
1
```

The trailing "(That lesson, quiz or scenario does not exist.)" is the API's own 404 body, so the
request reached the API and was rejected on the path. `apps/web/next.config.ts` contains no
rewrite, and `API_ORIGIN` defaults to `http://localhost:3001` where the API is running.

**Evidence.** `apps/web/src/fixtures/legends.ts:650-655`:

```ts
export const LEGEND_PROFILES_FIXTURE: LegendProfilesResponse = {
  namingMode: 'attributed',
  profiles: LEGEND_PROFILE_FIXTURES,
  ...
```

and `:191-201`:

```ts
return {
  displayName: `${input.attributedName} (modelled style)`,
  ...
  attributed: true,
  disclaimers: [UNIVERSAL_DISCLAIMER, ATTRIBUTION_DISCLAIMER],
```

Same root cause affects `/api/session`, `/api/content/lessons` and `/api/content/glossary` — the
`/learn` index also renders its fallback — so this is a shared wiring defect, but the Legends
consequence is the one that crosses a release-blocking guardrail.

**Fix.** Add the version segment to `LEGEND_API_PATHS` (and to `learn-data.ts` and `api.ts`'s
`/api/session`), preferably by importing a single `API_PREFIX` constant from `@prl/contracts` so
the two cannot drift again. **Independently**, change the fixture to `namingMode: 'archetype'` with
`archetypeDisclosure` for every profile: an offline render path must never be able to display an
attributed name, because the whole point of the env var is that a human decides. If the attributed
rendering genuinely needs a render-check, put it in a test fixture that the app cannot reach.

**Missing test.** (a) A test that asserts every path in `LEGEND_API_PATHS`, `LEARN_API_PATHS` and
`api.ts` resolves to a route the Fastify app actually registers (enumerate `app.printRoutes()` or
assert the shared prefix constant is used). (b) A test asserting that no fixture reachable from a
production code path has `namingMode === 'attributed'` or `disclosure.attributed === true`. (c) An
end-to-end smoke check that `/legends` renders live data — i.e. that no page in the app renders a
`fallbackReason` when the API is up.

## P1

### F2 — The Coach publishes raise sizes the engine rejects, and prints one of them as its suggested size range

**Location:** `packages/poker-math/src/coach.ts:249-251` — `to: input.toCall + option.amount` —
with `CoachInput` (`:54-76`) carrying no `committedThisStreet` and `buildCandidates` never
consulting a minimum-raise rule. Rendered at `packages/ui/src/components/CoachPanel.tsx:452` and
`apps/web/src/components/PostHandComparison.tsx:263`.

**Problem.** The engine's `Action.to` is a seat's **total** commitment for the street. The Coach
computes `to = amountToCall + betSize`, which omits whatever hero has already put in this street,
and it applies no minimum-raise floor at all. Both errors point the same way, so the Coach routinely
publishes raise sizes below `legalActions[].minTo` — sizes the table will refuse — and prints the
smallest of them as the lower bound of `CoachSuggestion.sizeRange` ("Raise — 33 to 990").

**Reproduction.** Heads-up, blinds 5/10, 1000 stacks. The button raises to 30; hero is the big
blind with 10 already committed. I asked the engine to validate each of the Coach's own raise
candidates:

```
COACH view: potTotal=40 amountToCall=20 heroCommittedThisStreet=10
COACH engine legal raise: minTo=50 maxTo=1000
COACH raise candidates: to=33 cost=13 ev=34.01 | to=46 cost=26 ev=36.77 | to=990 cost=970 ev=237.21
COACH suggestion: raise sizeRange={"min":33,"max":990}
COACH engine verdict to=33: REJECTED (BettingRuleError: raise to 33 is below the minimum of 50)
COACH engine verdict to=46: REJECTED (BettingRuleError: raise to 46 is below the minimum of 50)
COACH engine verdict to=990: LEGAL
COACH rejected 2/3 of the Coach's raise sizes
```

Postflop, hero bets 20 and is raised to 80:

```
COACH2 potTotal=120 amountToCall=60 heroCommittedThisStreet=20 engine minTo=140 maxTo=990
COACH2 candidate raise to=100 cost=40 -> REJECTED (raise to 100 is below the minimum of 140)
COACH2 candidate raise to=140 cost=80 -> LEGAL
COACH2 candidate raise to=970 cost=910 -> LEGAL
```

**Evidence.** `coach.ts:248-256`:

```ts
candidates.push({
  action: input.toCall === 0 ? 'bet' : 'raise',
  to: input.toCall === 0 ? option.amount : input.toCall + option.amount,
  cost: option.amount,
```

`CoachPanel.tsx:452`:

```tsx
{range === undefined ? '' : ` — ${formatUnits(range.min)} to ${formatUnits(range.max)}`}
```

The `cost` field is correct (chips added), so the EV arithmetic is sound; it is the `to` label and
the legality that are wrong. Downstream, `candidateForAction`
(`packages/poker-ai/src/commentary.ts:475-488`) and `candidateFor`
(`apps/web/src/lib/consistency.ts:76-88`) match the learner's actual action by `to`, so a hand
review silently pairs a legal raise with the nearest mislabelled candidate.

**Fix.** Add `heroCommittedThisStreet` and the engine's `minRaiseTo` (or the whole `LegalAction`
set) to `CoachInput`; compute `to = heroCommittedThisStreet + toCall + betSize`; drop or clamp any
ladder entry whose resulting `to` is below `minRaiseTo`, and drop `sizeRange` entirely rather than
publish a bound that is not offerable. The live call site
(`apps/api/src/ws/router.ts:620-654`) already has the view and can supply all of it.

**Missing test.** For a set of real engine states covering (i) preflop from the blinds, (ii) a
re-raise after hero has bet, and (iii) a short stack whose only raise is an all-in below the
minimum: build the Coach report from `redactFor(state, seat)` and assert that **every**
`candidate.to` for `bet`/`raise` passes `validateAction(state, seat, { type, to })`, and that
`suggestion.sizeRange.min` and `.max` do too.

### F3 — The live profile page presents invented statistics as "Measured over 128 hands of your own play"

**Location:** `apps/web/src/fixtures/legends.ts:714-725` (`PATIENT_TECHNICIAN_OBSERVED`) surfaced
through `learnFromFixture` (`:728-739`) and rendered by
`apps/web/src/app/legends/[profileId]/page.tsx:145-152` (`ObservedTable`).

**Problem.** Because of F1 the fixture path is always taken, and one profile carries a fabricated
`ProfileObservedStats` object (128 hands, VPIP 0.27, PFR 0.22, 3-bet 0.07, aggression 0.61, bluff
0.31, showdown 0.24, fold-to-bet 0.58, mean size 0.62, half-width 0.08). `ObservedTable` prints its
own note asserting provenance the data does not have. A page-level "bundled sample data" banner
exists, but the table's own sentence contradicts it.

**Reproduction.**

```
$ curl -s http://127.0.0.1:3000/legends/patient-technician | grep -o "Measured over [^<]\{0,120\}"
Measured over 128 hands of your own play, not declared by the profile. Every figure below carries
the same sampling interval of 8.0 points, and several of the differences between profiles are
narrower than that — w…
$ curl -s http://127.0.0.1:3000/legends/patient-technician | grep -c "bundled sample data"
1
```

**Evidence.** `page.tsx:148-150`:

```tsx
<p className="prl-legend-observed__note">
  {`Measured over ${pluralise(observed.handsObserved, 'hand')} of your own play, not declared by the profile. …`}
</p>
```

Nothing in `ObservedTable` receives the `LegendData.source` discriminator, so it cannot qualify the
sentence even when it wants to. This is a product that teaches "a figure whose assumptions you
cannot read is a figure you cannot check" — inventing a session is the one thing this feature must
not do.

**Fix.** Remove `PATIENT_TECHNICIAN_OBSERVED` from the reachable fixture (`observed: null` for
every fixture profile), or thread `source` into `ObservedTable` and change the sentence to name the
sample as illustrative when `source === 'fixture'`. The first is safer.

**Missing test.** A render test asserting that when `loadLearnFromProfile` returns
`source: 'fixture'`, no rendered string contains "of your own play"; plus a static assertion that
no reachable fixture supplies a non-null `observed`.

## P2

### F4 — `ProfileStatsResponse` — declared traits versus a large simulation, with `divergences` — is a dead contract

**Location:** `packages/contracts/src/legends.ts:291-311`. No producer, no consumer.

**Problem.** `docs/AI-LEGENDS.md` §9 presents this as a shipped honesty feature:
"`ProfileStatsResponse.divergences` surfaces the axes where a large simulation **disagrees** with
the profile's declared trait. Not hidden, not smoothed: a model whose behaviour does not match its
own card is a defect, and showing it is how it gets fixed." §11 lists it again. Nothing implements
it, so a learner is never shown any divergence — and there are real ones to show (F5).

**Reproduction.**

```
$ grep -rn "divergence" --include='*.ts' --include='*.tsx' apps/ packages/contracts/src packages/ui/src \
    | grep -v node_modules | grep -v /dist/ | grep -v '\.test\.'
packages/contracts/src/legends.ts:305:  readonly divergences: readonly {
$ grep -rn "ProfileStatsResponse" apps/ | grep -v node_modules | grep -v /dist/
(no output)
$ grep -n "legends" apps/api/src/routes/rooms.ts | grep "app\."
361:    app.get('/legends/profiles', ...
394:      '/legends/profiles/:profileId',
421:      '/legends/matches',
487:      '/legends/compare',
```

**Evidence.** Four Legends routes exist; none serves `ProfileStatsResponse`. `compareToDeclared`,
`describeDivergence` and `toObservedStats` in `packages/poker-ai/src/stats.ts` are exercised only by
tests.

**Fix.** Either implement the route (the pieces all exist: `simulateHeadsUpAgainstReference`,
`compareToDeclared`, `describeDivergence`, `toObservedStats`, and a seed to report) and render it on
the profile page, or delete the type and correct §9 and §11 of the doc. Do not leave a documented
guardrail unimplemented.

**Missing test.** A contract-coverage test asserting that every exported response interface in
`@prl/contracts` is either produced by a registered route or explicitly listed as intentionally
unused, with a reason.

### F5 — Every profile is measurably less aggressive and less 3-bet-happy than its own card, and nothing in CI can fail on it

**Location:** `packages/poker-ai/src/policy.ts:1190-1212` (the aggression weight and the comment
above it), `packages/poker-ai/src/stats.ts:568-588` (the two tolerances), and
`packages/poker-ai/test/simulation/profile-differentiation.test.ts:345-363` (the test that reports
but does not assert).

**Problem.** `policy.ts` states the direction of its own residual error and states it backwards:

```
* Everything after the odds is a reason to deviate from neutral, so the realised rate sits a
* little above the declared one: real hands are not all neutral, and a value hand should bet
* more often than the baseline. That direction is intended and is what the axis tolerance in
* `stats.ts` describes.
```

Measured, the realised aggression frequency sits **below** the declared value for **all twelve**
profiles, by 0.026 to 0.188. Twelve out of twelve in the same direction is p ≈ 2.4 × 10⁻⁴ under a
sign test — a systematic bias, not scatter. The same holds for 3-bet frequency: twelve of twelve
below declared. Two profiles breach their own documented tolerance on `threeBetTendency` and one on
`aggressionFrequency`, and the suite prints them without asserting, so this cannot fail CI.

**Reproduction.** Shipped suite, 8,000 hands × 12 profiles, seed 20,260,817:

```
3 divergence(s) across 12 profiles:
adaptive-exploiter — threeBetTendency: declares 0.660, simulation measured 0.323, further apart
  than the 0.300 this axis allows
volume-grinder — threeBetTendency: declares 0.780, simulation measured 0.404, further apart than
  the 0.300 this axis allows
disciplined-specialist — aggressionFrequency: declares 0.520, simulation measured 0.331, further
  apart than the 0.180 this axis allows
✔ the remaining measurable axes are reported, and any divergence is legible not hidden (0.256ms)
```

My own independent sweep (4,000 hands, seed 6,180,339) reproduces all three and shows the pattern
is universal — the `agg d/o` and `3bet d/o` columns in the table in §2 above are below declared on
every row:

```
MYSWEEP axis misses at documented tolerances:
  adaptive-exploiter 3bet -0.3246 | volume-grinder 3bet -0.3632 | disciplined-specialist agg -0.1885
```

**Evidence.** The profile card and the radar chart publish `aggressionFrequency: 0.52` for
`disciplined-specialist`; the model plays 0.331–0.332. `AI-LEGENDS.md` §11 claims "Play many
thousands of deterministic hands per profile and assert the observed VPIP, PFR, 3-bet, aggression,
bluff, fold-to-bet and mean bet-size … land within a stated tolerance" — only VPIP and PFR are
actually asserted.

**Fix.** Two separate corrections. (a) Delete or invert the claim in `policy.ts:1200-1203`; it is
the reverse of the measurement and it is the sentence a maintainer would trust when the number
drifts. (b) Assert on the remaining five axes in the simulation suite, with the divergence list as
the assertion value rather than a `console.log`. Whether the underlying shortfall is a bug or a
consequence of measuring an unconditional rate against a neutral-hand parameter is a design
question, but it must not be invisible: either tighten the model, widen the tolerance *with a
written reason*, or ship `ProfileStatsResponse` (F4) so the learner sees it.

**Missing test.** `assert.deepEqual(divergences, [])` in
`the remaining measurable axes are reported…`, plus a directional test: assert the *mean signed*
error across profiles on each axis is inside a stated band, so a one-sided bias fails even when
every individual profile is inside its own tolerance.

### F6 — `LearnFromProfileResponse.observed` is hard-coded `null`, so the "Observe" step of the documented educational loop does not exist

**Location:** `apps/api/src/routes/rooms.ts:394-411` (the `GET /legends/profiles/:profileId`
handler), `observed: null`.

**Problem.** `docs/AI-LEGENDS.md` §9 describes the six-step loop and its "Observe" row promises
"VPIP, PFR, 3-bet, aggression, bluff, showdown and fold-to-bet frequencies, average bet size as a
pot fraction — with a `confidenceHalfWidth`, so 40 hands are not over-read", and calls
`LearnFromProfileResponse` "a complete probability lesson delivered by the product doing its own
job". The API never populates it. The handler's own comment is honest about it; the doc is not.

**Reproduction.**

```
$ curl -s http://127.0.0.1:3001/api/v1/legends/profiles/patient-technician | python3 -c \
  "import json,sys; print(json.load(sys.stdin)['observed'])"
None
```

**Evidence.** `rooms.ts:405`: `observed: null,` with the comment "measured frequencies belong to a
learner's own session against the profile, and there is no honest way to fill it from nothing".
Nothing anywhere accumulates a per-learner `SeatObservations`, and `OpponentModel` instances live
on the bot seats rather than on the learner's seat.

**Fix.** Either accumulate the learner's own observed frequencies from the persisted hand history
for that room (the counters and denominators already exist in `stats.ts`) and fill the field, or
correct §9 of `AI-LEGENDS.md` to say the Observe step is not implemented. `null` in the type is
honest; the doc claiming otherwise is not.

**Missing test.** An API test that plays a legend match to a stated hand count and asserts
`observed.handsObserved` equals it and that `confidenceHalfWidth` matches
`1.96 × 0.5 / sqrt(handsObserved)`.

### F7 — No `Math.random` source scan exists for `poker-ai`, although the doc claims one is needed and warns about exactly this gap

**Location:** `packages/poker-ai/` has no equivalent of
`packages/poker-engine/test/rng.test.ts:28-45`. Claimed in `docs/AI-LEGENDS.md` §6 and in
`packages/poker-ai/src/policy.ts:254`.

**Problem.** `AI-LEGENDS.md` §6 says randomness is "never from `Math.random` — which is banned in
engine code and asserted absent by a source scan … **That scan is per-package by construction: it
reads the `src/` directory beside itself, so it covers `@prl/poker-engine` and `@prl/poker-ai`
needs its own copy rather than inheriting it. Worth naming, because a scan pointed at the wrong
package is worse than no scan — the repository looks guarded and is not.**" The doc names the
failure and then commits it. `policy.ts:254` states outright that "`Math.random` is banned in this
package and asserted absent"; nothing asserts it. There is no repo-wide scan either, so
`apps/api/src` and `apps/web/src` are unguarded too.

**Reproduction.**

```
$ ls packages/poker-engine/test/
betting.test.ts commitment.test.ts evaluate.test.ts exhaustive helpers.ts
hidden-information.test.ts invariants.test.ts pots.test.ts reference-evaluator.ts rng.test.ts
$ grep -rn "Math.random" packages/poker-engine/test/rng.test.ts | head -2
28:test('src/ never uses Math.random in code', () => {
36:    if (code.includes('Math.random')) offenders.push(entry.name);
$ grep -rn "Math.random" packages/poker-ai/test/ ; echo "exit $?"
exit 1
$ grep -rn "Math.random" scripts/ .github/ package.json | grep -v load-test.mjs ; echo "exit $?"
exit 1
$ for d in apps/api/src apps/web/src packages/poker-ai/src packages/poker-math/src; do
    echo "--- $d"; grep -rn "Math\.random" $d || echo "  none in code"; done
--- apps/api/src
apps/api/src/auth/oidc.ts:245: * … never `Math.random`, because a predictable `state` or  [comment]
apps/api/src/repositories/ids.ts:50: * ## `Math.random` appears nowhere in this file  [comment]
--- apps/web/src
  none in code
--- packages/poker-ai/src
packages/poker-ai/src/hand-strength.ts:308:  /** Injected, never `Math.random`. …  [comment]
packages/poker-ai/src/policy.ts:254:  /** Injected. `Math.random` is banned … asserted absent. */  [comment]
--- packages/poker-math/src
  none in code
```

**Evidence.** There is no live violation today — that is why this is P2 and not P1. What is missing
is the guard the release documentation says exists, in the one package where a `Math.random` would
destroy both determinism and the "cryptographic randomness only" guardrail.

**Fix.** Copy `packages/poker-engine/test/rng.test.ts`'s scan (including its self-test that the
scan can fail, and its comment-stripping) into `packages/poker-ai/test/`, or better, promote it to a
repo-level script in `scripts/` that walks every `*/src` directory and runs in CI. Then the doc's
claim becomes true.

**Missing test.** The scan itself, plus its own negative test (`stripComments('const x = Math.random();')`
must still contain the token; a comment mentioning it must not).

### F8 — Three incompatible definitions of clean and dirty outs, and the app reports "0 clean outs" in the lesson's own flagship example

**Location:** `packages/poker-math/src/outs.ts:20-47` (threshold definitions) versus
`packages/content/data/lessons/foundations.json` → lesson `counting-outs` (the "Clean, dirty and
imaginary" list and takeaway 2) versus `packages/content/data/glossary.json` entries
`clean-out`, `dirty-out` and `dirty-outs`.

**Problem.** Three definitions are in play:

1. **`outs.ts`:** `clean` = equity after that card ≥ **0.90**; `dirty` = ≥ 0.50 and < 0.90;
   `neutral` = < 0.50, "not an out at all". Thresholds are documented as a modelling choice.
2. **The lesson:** "A clean out **makes you the winner**. When it lands you are ahead of what your
   opponent actually holds." Takeaway 2: "Clean outs win the pot". Dirty = "improves your opponent
   more, **or** the hand it makes is second best, **or** there is still another card to come for
   them to draw out on you." Imaginary = "improves nothing that matters."
3. **The glossary:** `dirty-out` — "improves your opponent more, **because the hand it makes is
   second best**, or because there is another card to come". `clean-out` — "makes you the winner …
   when it lands, you are ahead."

Definitions 2 and 3 classify a card that leaves you *behind* as dirty; `outs.ts` classifies it as
neutral and never lists it. Definitions 2 and 3 classify a card that puts you ahead as clean;
`outs.ts` demotes it to dirty unless it clears 90%. And `OutsBreakdown` on the wire carries only
`clean`, `dirty` and `total` — there is no field for the lesson's third category, so the three-way
split the lesson teaches cannot be rendered from Coach output at all. Neither the lesson nor the
glossary states the 0.90/0.50 thresholds; only the Coach's own generated explanation does.

**Reproduction.** The lesson's first live calculation, verbatim from its own data
(`{"kind":"outs","heroCards":"Th9c","board":"Qh7h2h","opponentCards":"AhKc"}`):

```
--- hero Th9c board Qh7h2h vs AhKc
   equityNow=16.16% clean=0 dirty=5 total=5 neutral=40
   cleanCards=
   dirtyCards=9d(70%),9s(70%),Tc(64%),Td(64%),Ts(64%)
```

The lesson's prose for that exact spot says: "The cards that can actually win are the ones you were
not counting — the tens and nines that pair you". Those five cards are exactly what the app returns
— labelled **dirty**, with **zero** clean outs on the panel. The caption instructs the learner to
"split that draw into clean and dirty outs".

**Evidence.** `outs.ts:537-540`:

```ts
function classify(equityAfter: number, cleanThreshold: number, aheadThreshold: number): OutClassification {
  if (equityAfter >= cleanThreshold) return 'clean';
  if (equityAfter >= aheadThreshold) return 'dirty';
```

Also `packages/poker-math/src/coach.ts:393-403` gates the entire clean/dirty teaching note on
`outs.dirtyCount > 0`, and `:306-310` gates the corresponding `whatWouldChangeIt` line the same way.
In `fl-overcards-dirty-outs` — the scenario *named* for dirty outs — the app reports `clean=3
dirty=0`, so the teaching note never fires in the canonical dirty-outs spot. Duplicate glossary ids
`dirty-out` and `dirty-outs` also exist with different wording (and `clean-out` has no plural
twin), which is a maintenance hazard in itself.

**Fix.** Pick one definition and propagate it. The cleanest is to keep `outs.ts`'s three buckets but
rename them to what they measure (`safe` / `ahead-but-vulnerable` / `not-an-out`), expose all three
on `OutsBreakdown`, and rewrite the lesson's list and both glossary entries to match — including
stating the thresholds, since the lesson's own thesis is that a count without its assumption is "a
guess wearing a number". Merge `dirty-out` and `dirty-outs`.

**Missing test.** For every `liveCalculation` of kind `outs` in the content set, run `computeOuts`
and assert the returned `cleanCount`/`dirtyCount` are consistent with the surrounding lesson prose —
at minimum, assert `cleanCount > 0` wherever the caption or prose asserts that specific cards win,
and assert the glossary's definition text and `outs.ts`'s documented thresholds are generated from
one source.

### F9 — `outs.ts` tells the learner "Hero is already in front" while hero holds no pair against a made pair

**Location:** `packages/poker-math/src/outs.ts:567-582` (`alreadyAheadNote`), reached whenever
`equityNow >= aheadThreshold` (0.50).

**Problem.** "In front" is hand-strength language; `equityNow` is a two-cards-to-come equity. A
flop hand with a big draw can clear 50% equity while losing at showdown, and the message then makes
a false statement about the hand. This is not hypothetical — it fires on the third live calculation
in the `counting-outs` lesson.

**Reproduction.** The lesson's own fixture
(`{"kind":"outs","heroCards":"AhKh","board":"Qh7h2c","opponentCards":"QsJd"}`):

```
--- hero AhKh board Qh7h2c vs QsJd
   equityNow=53.43% clean=15 dirty=0 total=15 neutral=30
   explanation=On Qh 7h 2c hero holds Ah Kh — high card ace, king queen kickers — for 53% equity
   against exactly QsJd. Of the 45 cards that can come next, 15 are clean and 0 are dirty, which is
   15 outs in total. … Hero is already in front before any card arr[ives]
```

The same sentence says hero holds "high card ace" — no pair — and the opponent holds `QsJd` on a
board containing `Qh`, i.e. a pair of queens. Hero loses at showdown right now.

**Evidence.** `outs.ts:574-580`:

```ts
if (equityNow >= aheadThreshold) {
  return (
    'Hero is already in front before any card arrives — equity now is above the same threshold a card '
    + 'has to clear to count as an out — so read the counts as cards that keep hero ahead rather than '
    + 'as the size of a draw'
  );
}
```

The qualifying clause is accurate; the leading clause is not, and the leading clause is the one a
learner reads. The lesson caption for this block says nothing about being ahead, so nothing on
screen corrects it.

**Fix.** Change the wording to be about equity rather than standing — e.g. "Hero's equity is already
above the threshold a card has to clear to count as an out, so read the counts as cards that keep
hero's share up rather than as the size of a draw" — and, better, compare `heroScore` against the
opponent's current score to decide whether hero is genuinely ahead at showdown before using the word
"in front".

**Missing test.** A test that constructs a hand which is behind at showdown but above 50% equity
(this exact fixture) and asserts the explanation does not claim hero is "ahead" or "in front"; plus
the converse for a hand that is genuinely ahead.

## P3

### F10 — Truncated sentence in `docs/AI-LEGENDS.md`

`docs/AI-LEGENDS.md:169-171`:

```
**The regex is a backstop, not the primary control.** It catches pronoun-led mental-state
attribution and first-person voice mechanically. It does **not** catch a proper noun followed
The guard is pattern-based, and a pattern list is crude by nature: it errs towards
```

The sentence ends mid-clause and runs straight into the next paragraph. Introduced by the edit that
added the two new patterns (fix 8). **Fix:** finish or delete the sentence — as written it also
contradicts the paragraph immediately below it, which says the shape *is* now caught.
**Missing test:** none practical; a doc lint for sentences ending without terminal punctuation would
catch it.

### F11 — Stale limitation L7 in `docs/AI-LEGENDS.md:623`

L7 still claims the guard "does not catch a proper noun followed by a mental-state verb, nor
`he/she/they would <verb>` outside four listed verbs" and proposes as the remedy "Assert that no
`naming.attributedName` string appears anywhere in generated commentary." All three statements are
out of date: `labelling.ts:207-221` now catches the capitalised-name-plus-mental-state-verb shape
and bans gendered pronouns outright, and `commentary.ts:246-260` already implements the proposed
name check. Verified by running `findImpersonation('Ivey senses weakness and applies pressure.')`
via the shipped `test/commentary.test.ts:376`. **Fix:** rewrite L7 to describe what remains
uncovered. **Missing test:** none; this is prose.

### F12 — `docs/AI-LEGENDS.md` L10 claims `tournamentOrientation` uses Malmuth–Harville ICM; it does not

L10: "**Tournament instincts inherit the ICM model's approximations.** `tournamentOrientation`
weights survival using Malmuth–Harville…". In fact `poker-ai` never imports ICM at all:

```
$ grep -rn "icm\|ICM\|Malmuth\|Harville" packages/poker-ai/src/ ; echo "exit $?"
exit 1
```

The trait's only effect is `packages/poker-ai/src/policy.ts:1061`:

```ts
const survival = 1 + FOLD_SURVIVAL_SPAN * traits.tournamentOrientation * commitmentShare;
```

— a linear multiplier on the fold weight, with no payout schedule, no stack distribution and no
finishing-place model. The claim overstates the model in the section of the document that exists
precisely to understate it. **Fix:** replace L10 with what the code does. **Missing test:** an
assertion that `@prl/poker-ai` does not depend on `icm.ts`, so the doc and the import graph agree.

### F13 — `packages/poker-ai/src/traits.ts` still says "eleven" profiles

`traits.ts:4`, `:6` and `:291` — "Why a trait vector and not eleven hand-written strategies",
"Eleven bespoke strategies would be eleven things to test, eleven places for a bug", "rather than
being eleven variations on one". The set is twelve (`PROFILES.length === 12`, and
`docs/AI-LEGENDS.md` says twelve throughout). **Fix:** derive the count in prose from
`PROFILES.length` where possible, or update the three comments. **Missing test:** a test asserting
`PROFILES.length` matches the count in the AI-LEGENDS profile table, so the two cannot drift.

### F14 — Imprecise variance wording in the `sample-size-and-risk-of-ruin` lesson

The formula block's explanation says: "risk falls exponentially as the bankroll grows, it falls
exponentially as the edge grows, and it **rises with the square of the standard deviation**.
**Variance is the only one of the three that enters squared**, which is why it dominates the
answer." It is the *standard deviation* that enters squared; *variance* (σ²) enters to the first
power. In a lesson whose subject is exactly this distinction the loose use of "variance" for "the
spread" is worth fixing. The `riskOfRuin` derivation in `variance.ts` gets it right
("the standard deviation enters squared"). **Fix:** say "the standard deviation is the only one of
the three that enters squared". **Missing test:** none; prose.

### F15 — Two scenario claim kinds are implemented but never used by any content

`checkScenarioClaims` (`packages/content/src/scenario-analysis.ts:296-352`) handles
`dirtyOutsAtLeast`, `equityBetween`, `breakEvenEquityBetween`, `sprBetween` and
`ruleOf24ErrorAtMost`, but the content suite reports `74 independent verification, 0 regression
locks` — so none of the five is exercised by real content. The `default:` branch handling
`ruleOf24ErrorAtMost` is unreachable from the shipped data. **Fix:** either use them (a
`ruleOf24ErrorAtMost` claim on the rule-of-2/4 scenarios would be genuinely valuable) or delete the
unused branches. **Missing test:** a coverage assertion that every `ScenarioClaim['kind']` appears
in at least one shipped scenario, or an explicit allow-list of unused kinds.

### F16 — `docs/AI-LEGENDS.md` §7 overstates what the hidden-information test instruments

§7: "The policy input is wrapped in a **`Proxy` that records every property path read**". In
`packages/poker-ai/test/no-hidden-information.test.ts:339` only `input.view` is wrapped; the other
six keys — including `observations`, the one a privileged caller could actually use as a side
channel — are passed raw. The property does hold: I wrapped all seven keys over 1,267 decisions and
the read set was clean (§1). But the doc describes a stronger test than the one that runs. **Fix:**
wrap the whole `PolicyInput` in the shipped test (it is a two-line change and it costs nothing), or
narrow the doc. **Missing test:** the whole-input proxy version, asserting the top-level key set is
exactly the seven permitted and that no read path under `observations` returns a card.

### F17 — The `real <first name>` impersonation pattern is a hand-maintained first-name list

`packages/poker-ai/src/labelling.ts:231`:

```ts
pattern: /\breal\s+(?:Phil|Doyle|Erik|Johnny|Daniel|Michael|Shaun|Benny)\b/i,
```

It covers today's ten attributed names by first name only, so "the real Hellmuth" and "the real
Negreanu" pass, and adding a profile whose first name is not in the list silently loses coverage.
`commentary.ts` already derives its token list from `PROFILES` — the same technique applies here.
**Fix:** build this pattern from `naming.attributedName` tokens rather than typing names in.
(Cannot be done in `labelling.ts` without an import cycle; either move the check to `commentary.ts`
or inject the token list.) **Missing test:** for every `attributedName` in `PROFILES`, assert
`findImpersonation('the real ' + token)` is non-empty for each of its name tokens.

### F18 — `apps/web/src/lib/legends-data.ts` describes its own endpoints as provisional

`legends-data.ts:43-46`: "**Provisional endpoint paths.** The API team owns the final names; the
`/api/...` prefix follows the one route that already exists (`GET /api/session`)." The referenced
route does not exist either (`/api/session` → 404; there is no `/api/v1/session` either — the
session route is elsewhere). A release should not ship a comment saying its own network contract is
unsettled. This is the comment that documents F1's root cause, so fixing F1 should remove it.
**Fix:** replace with the real, versioned paths imported from a shared constant. **Missing test:**
covered by F1's test (a).

---

## What I could not verify

* **`POST /api/v1/legends/compare` end to end.** It is CSRF-protected (correctly), and I did not
  mint a session to exercise it:
  `{"error":{"code":"csrf_failed",...}}`. `compareProfilesOnSpot` is exercised by
  `apps/api/test/bots.test.ts` (7/7 pass) and I read the code path; I did not observe a live
  response. The *web* compare page renders the fixture regardless (F1).
* **The scenario-mode comparison, the Legend post-hand comparison and the replay commentary as a
  learner would see them.** All three render from fixtures in the running app (F1), so I read the
  server code and the fixtures rather than observing live output.
* **The claimed measurement in `AI-LEGENDS.md` §3 that the two new impersonation patterns have
  "zero false positives across all 4,955 strings this package can produce".** I confirmed 137/137
  package tests pass and that `commentary.test.ts` enumerates generated strings, but I did not
  reproduce the 4,955 figure or re-run the false-positive sweep myself.
* **The claimed multiway-equity error table in `hand-strength.ts:41-49`** (mean absolute error 2.3
  points, worst case 6.9). I verified the *formula* reproduces the two figures the comment quotes
  (88 vs five opponents → 30.8%; AA vs three → 57.0/57.1%) and that both are consistent with known
  true values, but I did not re-run the 18-class × 4-opponent Monte Carlo sweep.
* **Difficulty behaviour at a live table** (`expert` withdrawing the Coach during the hand). I
  verified `DIFFICULTY_SETTINGS.expert.coachAvailable === false` and that the simulation suite
  proves the trait-muting and adaptation claims, but I did not play a live expert match through the
  UI.
* **Whether the P0 wiring defect is also reported by another agent.** I did not read other
  reviewers' output. The `/v1` prefix mismatch affects `/api/session`, `/api/content/*` and
  `/api/legends/*` alike, so it is likely to appear in more than one report; I have scoped my
  finding to the Legends consequence that crosses a guardrail.
