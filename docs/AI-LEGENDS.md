# Poker Risk Lab — AI Poker Legends

**Version:** 1.0 · **Last reviewed:** 2026-08-17

The learning mode where you sit down against a set of contrasting expert *styles*, watch how
each one behaves, and then compare your own decisions against the maths.

This document explains what the mode is, what it deliberately is not, and where each
guardrail is enforced in code rather than in a review convention. Section 12 is the honest
part, in the manner of `docs/THREAT-MODEL.md` §9.

---

## 1. What the mode is, and what it is not

**It is a set of twelve educational strategy simulations.** Each one is a numeric vector of
sixteen playing tendencies — how many hands it enters, how aggressively it bets, how much it
cares about position, how readily it folds a made hand — fed through a single shared decision
engine. The vectors were chosen to *contrast with each other*, because feeling the difference
between a style that never folds and a style that folds correctly is a lesson no amount of
prose delivers.

**It is not celebrity simulation.** Stated plainly, and it matters more than anything else
here:

* The numbers are **design parameters**, not measurements. Nobody's real VPIP is in
  `packages/poker-ai/src/profiles.ts`. Where a profile carries an attributed name, the traits
  gesture at tendencies that have been *widely discussed in public poker commentary* —
  "plays a lot of hands and applies pressure", "famously patient" — at exactly that level of
  coarseness and no finer.
* **No hand histories were consulted.** None. Not a database, not a televised final table,
  not a published chart of anyone's statistics.
* **Nobody endorsed, approved, reviewed or is affiliated with any of this.** No permission was
  sought and none is implied, because none of the content depends on any.
* **No private decision-making is reproduced.** These models have no inner life to reproduce.
  A profile does not think, feel, sense, read or intend anything, and this codebase will not
  say that it does — see §3.
* **No claim of resemblance.** A profile is a coarse approximation of a *style*. Any
  resemblance to how a particular person plays is limited to broad strategic tendencies, and
  the product says so next to every profile, in both naming modes.

Two of the twelve profiles have no attributed name at all: a fundamentals-first study model
and a passive calling station. The calling station is in the set on purpose — it is the
clearest demonstration that the traits do the teaching and the names are only mnemonics.

And the ordinary product rules still apply. Units are free, resettable and valueless; there
is no purchase path, no prize, no leaderboard and no streak (`docs/PRODUCT-GUARDRAILS.md`
§1, §2). Playing a hundred hands against a profile earns you an analysis, not a badge.

## 2. Naming: archetypes by default, attribution by explicit opt-in

Every profile carries **both** names. `packages/poker-ai/src/labelling.ts` decides which one
the product shows.

| Mode | Configuration | What the seat plate says |
| --- | --- | --- |
| `archetype` | the default; `PRL_LEGEND_NAMING` unset or empty | `Heads-Up Pressure Expert` |
| `attributed` | `PRL_LEGEND_NAMING=attributed`, set deliberately | `<Attributed name> (modelled style)` |

**The safe mode is the default, because the mode you get by not thinking about it should be
the safe one.** That is the whole design. `resolveNamingMode()` reads the environment itself
rather than accepting a mode parameter, which sounds like the wrong instinct for a pure
package and is not: a parameter can be forgotten at a call site, and the forgotten value
would be whichever one the author of that call site happened to default to. Reading the
environment in one place makes the safe answer unavoidable.

An unrecognised value **throws** `LabellingError` rather than falling back. `PRL_LEGEND_NAMING=true`
is a typo, not a request, and a server that boots with a misspelled naming mode is a server
whose naming mode nobody knows.

**Setting the variable is the moment to consider name, image and likeness permissions.**
Using a living person's name in a product may require permission. That question belongs to
whoever deploys this, not to this codebase, and the opt-in exists so that the question is
asked by a person rather than answered by a default.

### The disclaimers travel with the name

`profileDisclosure(naming, mode)` returns the display name and its disclaimers **in the same
object**. There is deliberately no function that returns a name on its own.

* `UNIVERSAL_DISCLAIMER` — always, in both modes. Educational strategy simulations, not real
  people, not digital copies, not endorsed by anyone.
* `ATTRIBUTION_DISCLAIMER` — added whenever an attributed name is actually displayed. Coarse
  approximation of a style, from general reputation, not from anyone's hand histories or
  thinking, not affiliated, nothing here represents their views.
* `COURSE_PROFILE_DISCLAIMER` — added for the course-derived study profile, which represents
  general widely-taught fundamentals and does not reproduce or summarise any particular
  course, book or proprietary material.

On the wire, `ProfileDisclosureDto.disclaimers` is a **required, non-empty array**
(`packages/contracts/src/legends.ts`). A component that renders `displayName` and drops
`disclaimers` is visibly wrong in review rather than quietly non-compliant, which is the
point of putting the guarantee in the type instead of in a style guide.

### The educational content is identical in both modes

`learnFrom`, `styleNotes`, `counterStrategy`, `modelBasis`, the trait vector, the radar axes,
the difficulty behaviour and every number in the post-hand comparison are **byte-identical**
whichever mode is set. Nothing a learner is taught depends on whose name is on the seat.

That is not a coincidence; it is the evidence. If the names were carrying teaching weight,
switching modes would change what the product taught. It does not, so they are mnemonics and
the traits are the substance.

No profile is paired with its attributed name anywhere in this document. `profiles.ts` is the
source of truth for that mapping, and a document that reproduces it reads as a roster of
endorsements — which is the exact impression the whole design exists to avoid. (§3 quotes one
name inside an example of a string the guard *rejects*; a banned string is the opposite of an
endorsement.) Ten of the twelve profiles
carry one in `naming.attributedName`; two of those ten are attributed to players who have
died, and they get exactly the same treatment as everyone else. Being unable to object is not
a reason to be less careful.

## 3. The impersonation ban, and how it is enforced

**Commentary is always in the third person, always about the model.**

**GOOD** — describes what the model prefers, and why, from its own declared parameters:

> "This model prefers a larger bet here because its sizing preference is high and the board
> favours the range it represents."

> "At this stack depth the model's stack-depth adjustment pushes it towards committing rather
> than calling for a price it usually takes."

**BAD** — banned outright, in every surface, at every difficulty:

> "Ivey senses weakness and applies pressure." — fabricates a real person's perception

> "He would raise here." — speaks for a person about a decision they never made

> "I like a bet here." — first-person voice reads as the person speaking

The first two are fabrication about a real human presented as insight. The third is a voice
this product has no right to use. All three are also the easiest way for an educational tool
to become disrespectful, and once one string does it the rest follow.

### Where the enforcement sits

`assertNoImpersonation(text, where)` throws `LabellingError` on text that impersonates rather
than describes. It runs in two places, and the first one is the interesting one:

1. **At profile load time.** `validateProfiles()` runs at module scope in `profiles.ts`, over
   every `learnFrom`, `styleNotes`, `counterStrategy`, `modelBasis` and `archetypeTagline`
   string in the set, producing the exported `PROFILES` constant. An impersonating profile
   therefore **cannot be imported** — the module throws on load, so the API does not start,
   so the string cannot be shipped. Not a test that someone might skip; a failure to boot.
2. **At commentary generation time**, on every learner-facing string, as it is generated. Not
   in a test afterwards. If a generator *can* emit a string that fails the guard, that is a
   bug in the generator, and the assertion is where it surfaces.

The pattern set is deliberately crude and errs towards rejection. A false positive costs a
reworded sentence; a false negative ships a fabricated claim about a person.

| Rejected shape | Why |
| --- | --- |
| `he/she/they` + `thinks / feels / believes / senses / knows / reads / wants` | attributes a mental state to a person |
| `is thinking` / `was thinking` | narrates a person's thoughts |
| `would say / tell / think / feel` | puts words or thoughts in a person's mouth |
| `in his / her / their mind, head, view, opinion` | claims to report a person's inner view |
| `famously said / says / quoted` | implies a quotation |
| a string opening with `I` or `My` | first-person voice reads as the person speaking |
| `endorses / endorsed / approved by / official / partnership` | implies endorsement or affiliation |
| `digital twin / exact replica / exact reproduction / clone of` | overstates what the model is |
| `the real <first name>` | conflates the model with the person |

### Two traps in this design, named rather than left to be discovered

**The regex is a backstop, not the primary control.** It catches pronoun-led mental-state
attribution and first-person voice mechanically. It does **not** catch a proper noun followed
The guard is pattern-based, and a pattern list is crude by nature: it errs towards
rejection, because a false positive costs a reworded sentence while a false negative ships
a fabricated claim about a real person. It originally missed two shapes — a capitalised
name followed by a mental-state verb ("Ivey senses weakness" contains no pronoun at all),
and a gendered pronoun with a poker verb ("He would raise here", where `raise` is not a
speech verb). Both are now caught.

The two patterns that close it were chosen narrowly and measured, not guessed. Validated
against all 4,955 strings this package can produce, they have **zero false positives**.
Three looser variants were rejected because they broke real content: a bare mental-state
verb with no name in front rejected 15 authored coaching lines ("believe it", "make
sense", "folds far more than feels comfortable"); adding `reads`/`knows` to the name
pattern rejected 288, because the policy legitimately emits "Opponent read:"; and
broadening `would` to any following verb rejected 1,206.

The structural control remains the primary one: commentary can only be *generated* from
templates that describe the model, and the guard runs at generation time so an
impersonating string cannot be returned, let alone rendered.

**The disclaimer constants deliberately fail their own guard, and must not be swept into
it.** `UNIVERSAL_DISCLAIMER` says "not endorsed by anyone"; `ATTRIBUTION_DISCLAIMER` says
"not affiliated with or approved by them". Both contain words the guard rejects, because a
*disclaimer* must be able to deny endorsement while a *commentary string* must never assert
it. The guard is scoped to authored profile prose and generated commentary, and the
disclaimers are reviewed constants outside it. Widening the sweep to cover them would make
the package throw on import, which is a confusing way to find out.

## 4. The trait model

### Why a trait vector rather than twelve bespoke strategies

Twelve hand-written strategies would be twelve things to test, twelve places for a bug, and
no way to say *how* any two of them differ. A shared decision engine driven by a numeric
vector buys three things worth more than expressiveness:

1. **Comparability.** "This profile enters 42% of pots and raises 80% of those; that one
   enters 15% and raises 90%" is a sentence a learner can act on. It is also a radar chart,
   and a test assertion, and a diff between two profiles.
2. **Testability.** A statistical run can play tens of thousands of deterministic hands per
   profile and assert that the *observed* frequencies match the *declared* traits. A
   hand-written strategy can only be tested against itself.
3. **Honesty.** The vector is the whole model. Nothing hides in hand-tuned special cases, so
   the profile card can show a learner exactly what they are facing. That is the difference
   between an educational tool and a black box with a famous name on it.

Every axis is on a 0..1 scale, so the radar view is meaningful without per-axis rescaling and
two profiles can be compared at a glance. Read each value as "how far towards the second
option", so 0 and 1 are both meaningful extremes rather than "off" and "on".

`assertValidTraits` **rejects** out-of-range and non-finite values rather than clamping them.
A trait quietly clamped from 1.4 to 1.0 would make a profile behave differently from what its
own card claims — and the card is the teaching material.

### The sixteen axes

| # | Axis | Label shown | What it means, and what it costs |
| --- | --- | --- | --- |
| 1 | `vpip` | Hands played | Fraction of hands entered when folding is free. Maps onto conventional VPIP: 0.15 is very tight, 0.5 very loose. More hands wins more small pots and loses more big ones. |
| 2 | `pfrShareOfVpip` | Raises rather than calls | Preflop raising as a **share of** `vpip`. 1.0 never limps or cold-calls. Expressed relatively because PFR > VPIP is impossible, and a relative field makes that unrepresentable. |
| 3 | `aggressionFrequency` | Aggression | How often it bets or raises when aggression is available and its hand read is neutral. The single biggest driver of how a profile *feels* to play against. |
| 4 | `bluffFrequency` | Bluffing | How often it bets with a hand that cannot win at showdown. Distinct from aggression: a profile can bet often with good hands and rarely bluff, or the reverse. |
| 5 | `positionSensitivity` | Position awareness | How much acting last changes its decisions. The axis most worth making a learner notice, because position is the cheapest edge in poker and the easiest to ignore. |
| 6 | `threeBetTendency` | Re-raises preflop | Willingness to re-raise an opener rather than flat-call. Re-raising isolates and takes control, in a bigger pot with less information. |
| 7 | `betSizingPreference` | Bet size | Preferred pot fraction before other adjustments; 0 maps to a quarter pot, 1 to one and a half pots. Bigger bets charge draws more and risk more to win the same pot. |
| 8 | `sizingVariance` | Varies bet size | 0 uses one size for everything — simple, readable, exploitable. 1 changes size with texture and strength. A learner facing 0 can start reading sizes; facing 1 they cannot, and noticing that is the lesson. |
| 9 | `valueBluffBalance` | Value-heavy vs bluff-heavy | 0.5 is roughly balanced. Below it, more bluffs than value (call more). Above it, the reverse (fold more). |
| 10 | `pressureTendency` | Applies pressure | Willingness to put opponents to a decision for a large part of their stack. About *how much*, where aggression is about *how often*. |
| 11 | `stackDepthAdjustment` | Adjusts to stack depth | 0 plays 15 big blinds like 150, which is a real and instructive mistake. 1 shifts sharply towards push-or-fold as stacks shorten. |
| 12 | `tournamentOrientation` | Tournament instincts | 0 is pure chip-EV cash thinking; 1 weights survival and ladder position heavily. Visible in how it treats a marginal all-in. |
| 13 | `riskTolerance` | Risk appetite | Appetite for thin edges and the swings they carry. Deliberately distinct from aggression: a profile can be relentless in small pots and risk-averse in big ones. |
| 14 | `exploitativeAdaptation` | Adapts to opponents | How far it moves from a fixed strategy towards attacking observed tendencies — from **public** behaviour only, never from hidden cards. |
| 15 | `foldToPressure` | Folds under pressure | How readily it gives up a made hand. Folding too little pays off every bluff; folding too much invites them. |
| 16 | `barrelPersistence` | Keeps betting | Whether it follows through on later streets after taking the lead. Following through wins more pots and costs more when called. |

No high value reads as "better". Every axis is a trade-off and every description says what it
costs, because a radar chart where one shape is obviously the good one teaches a learner to
copy a shape instead of to reason.

### Derived quantities the decision engine actually uses

| Helper | Mapping | Why it exists |
| --- | --- | --- |
| `preflopRaiseFrequency` | `vpip × pfrShareOfVpip` | Absolute PFR, which cannot exceed VPIP by construction |
| `preferredPotFraction` | `0.25 + betSizingPreference × 1.25` | Turns a normalised axis into a real pot fraction (0.25 to 1.5) |
| `positionalVpipMultiplier` | `swing = 0.45 × positionSensitivity`; `1 − swing + relativePosition × 2 × swing` | At full sensitivity, entry frequency spans 0.55× in the worst seat to 1.45× in the best; at 0 it is flat 1.0× everywhere |
| `stackDepthCommitmentMultiplier` | 1.0 at 40bb and above, ramping to `1 + stackDepthAdjustment` at 5bb and below | Below roughly 20bb implied odds stop existing, and a profile that ignores that is beatable |
| `traitDistance` | mean absolute difference across all sixteen axes | Lets a test assert the set spans real styles rather than twelve variations on one |
| `biggestTraitDifferences` | the axes where two profiles differ most | Drives the "how does this compare?" copy and `LearnFromProfileResponse.contrasts` |

### The twelve profiles

Signature axes are the ones a profile is most defined by; they are what the card highlights.

| Profile id | Archetype name | Signature axes | Best for |
| --- | --- | --- | --- |
| `vocal-aggressor` | High-Variance Tournament Aggressor | aggression, folds under pressure (low), tournament instincts | six-max |
| `adaptive-exploiter` | Adaptive Exploitative Pro | adapts to opponents, varies bet size, position awareness | both |
| `patient-technician` | Patient Positional Technician | position awareness, hands played (low), folds under pressure | both |
| `reading-pressure-specialist` | Heads-Up Pressure Expert | applies pressure, keeps betting, hands played | heads-up |
| `old-school-pressure` | Classic Aggressive Fundamentalist | bet size, varies bet size (low), aggression | six-max |
| `mixed-game-generalist` | Mixed-Game Structural Generalist | adjusts to stack depth, varies bet size, position awareness | both |
| `volume-grinder` | High-Volume Analytical Grinder | risk appetite, re-raises preflop, adjusts to stack depth | six-max |
| `disciplined-specialist` | Disciplined Mixed-Format Specialist | hands played (lowest), value-heavy, risk appetite (low) | both |
| `foundational-reader` | Foundational Read-Based Player | adapts to opponents, position awareness (low), varies bet size (low) | six-max |
| `range-narrator` | Range-Reading Communicator | adapts to opponents, hands played, bet size (small) | both |
| `fundamentals-coach` | Fundamentals-First Study Model | varies bet size (low), adapts to opponents (low), position awareness | both |
| `calling-station` | Passive Calling Station | aggression (lowest), folds under pressure (lowest), raises rather than calls (lowest) | both |

The set genuinely spans a range: `vpip` runs from 0.15 to 0.52, `aggressionFrequency` from
0.16 to 0.74, `sizingVariance` from 0.15 to 0.86, and `exploitativeAdaptation` from 0.10 to
0.95. `profileDiversity()` reports the minimum and mean pairwise `traitDistance` and names the
closest pair, so a test can assert the floor. A set that looked diverse on its cards and
played identically would be the quiet failure here, and it is the one worth guarding against.

Every profile also carries prose that is part of the product rather than decoration:

* `learnFrom` — what a student should take from playing it. This is the actual deliverable.
* `styleNotes` — how the style shows up at the table, behaviourally.
* `counterStrategy` — how to play *against* it. Included deliberately: an opponent you cannot
  form a plan against teaches nothing.
* `modelBasis` — one honest sentence about where the parameters came from.

## 5. The decision pipeline

Six stages, in order, for every decision the model makes:

```
   1. ASSESS      own cards + board + one range assumption per live opponent
                  → equity, via @prl/poker-math (bounded, seeded, sample count
                    set by difficulty)

   2. SCORE       for each action in view.legalActions — and only those —
                  compute a preference score from equity, price, pot size,
                  effective stack and SPR

   3. ADJUST      apply traits (aggression, bluff, sizing, value/bluff balance,
                  risk, barrel persistence), position via
                  positionalVpipMultiplier, stack depth via
                  stackDepthCommitmentMultiplier, and observed opponent
                  frequencies scaled by exploitativeAdaptation

   4. NOISE       add difficulty noise: 0.18 educational, 0.10 realistic,
                  0.05 expert

   5. NORMALISE   scores → a probability distribution over the legal actions

   6. SAMPLE      draw from that distribution using the injected RandomSource,
                  then clamp any size to the engine's minTo / maxTo
```

**The engine decides legality; the policy only proposes.** This is not a stylistic
preference, it is the same rule that governs a human client (`docs/ARCHITECTURE.md` §5, ADR
0002):

* The candidate set is `view.legalActions`, which `redactFor` populated by calling
  `legalActions(state, seat)`. It is empty unless it is that seat's turn.
* A policy never constructs an action type the engine did not offer. There is no code path
  that invents a `raise` when the engine offered only `call` and `fold` — for example after a
  short all-in, where `mayRaise` is false and raising is genuinely unavailable.
* Every size is clamped to the `minTo` and `maxTo` the engine supplied on that specific legal
  action, including the case where a seat's stack only reaches an all-in that is short of the
  minimum raise.
* The action then goes through `validateAction` like any other, and the engine re-derives the
  legal set from its own state. A policy bug produces a rejected action and an error, not a
  silently illegal game. `test/invariants.test.ts` in the engine already asserts across
  thousands of randomised hands that a rejected action leaves the state byte-identical.

Stage 1 is where the range assumption enters, and it is the coarsest part of the model:
opponent tightness is a single number mapped onto a range through
`topPercentRange()`, which orders the 169 starting-hand classes by all-in equity against a
random hand. That ordering is *computed*, not transcribed from a published chart, so it is
original and auditable — and it is still only an ordering for one narrow question. §12 says
what that costs.

## 6. Probabilistic, not scripted

**Identical situations must not always produce identical actions.** A scripted opponent is a
puzzle to be solved once; a probabilistic one has to be reasoned about every time. More
importantly, a learner who watches the same spot produce a bet three times and a check twice
has learned something true about poker that no lesson states as convincingly: several actions
can be defensible in one spot.

So stage 5 above produces a **distribution**, and stage 6 samples from it. The distribution
is not an implementation detail hidden behind the sampled action:

* `ModelReasoning.actionProbabilities` carries the probability assigned to each action
  **before** sampling, so the replay view can show a learner that the action they saw was one
  of several plausible ones.
* `CompareProfilesResponse` runs the same situation many times per profile and returns an
  `actionDistribution` with a median size per action, plus a `takeaway` written to point at
  the *disagreement* between profiles — because two defensible styles differing on the same
  spot is the lesson.

### Determinism is preserved by injection, not by avoiding randomness

Randomness comes from an injected `RandomSource` (`packages/poker-engine/src/rng.ts`), never
from `Math.random` — which is banned in engine code and asserted absent by a source scan that
has its own test proving it can fail. That scan is per-package by construction: it reads the
`src/` directory beside itself, so it covers `@prl/poker-engine` and `@prl/poker-ai` needs its
own copy rather than inheriting it. Worth naming, because a scan pointed at the wrong package
is worse than no scan — the repository looks guarded and is not.

* In production the policy is handed the CSPRNG-backed source, `kind: 'csprng'`.
* In tests, in the statistical runs, and in reproducible teaching scenarios it is handed
  `createDeterministicRandomForTests(seed)`, `kind: 'deterministic-test-only'`, which refuses
  to run when `NODE_ENV === 'production'`.

The consequences are worth stating because they are what make the rest of this document
checkable. `CreateLegendMatchRequest.deterministicSeed` fixes the deal so a session can be
reproduced for teaching. `ProfileStatsResponse.simulationSeed` is reported alongside the
figures, so anyone can re-run the exact simulation the numbers came from. And a statistical
regression is reproducible from a seed rather than being a flake that reappears on Tuesdays.

Any hand dealt from the deterministic source is permanently labelled in the hand's
`randomSourceKind`, so a reproducible teaching hand can never be mistaken for a fairly dealt
one.

## 7. The information boundary

**A policy cannot cheat, because there is nothing to cheat with in its input type.**

The policy takes the seat's `PlayerView` — the already-redacted view from
`redactFor(state, { viewerSeat })` — plus its own hole cards, the public action history that
the view already carries, and its own accumulated counts of **public** opponent behaviour. The
shape matters more than the field names:

```ts
// Illustrative: what the policy receives.
{
  view,           // PlayerView — redacted for this seat, legalActions included
  ownCards,       // this seat's two cards
  observations,   // counters built only from view.actions, i.e. public actions
  traits,         // expressTraits(profile, difficulty)
  difficulty,     // DifficultySettings
  random,         // injected RandomSource
}
```

There is no `HandState` field. There is therefore no `deck`, no `deckCursor`, no `deckSalts`,
and no other seat's `holeCards` — not "absent by convention", but **unrepresentable**. To give
a policy a hidden card, someone would have to add a field to the input type, which is a
deliberate change in a file whose entire purpose is this boundary, rather than an oversight in
a file about betting logic.

This is the same fails-open/fails-closed argument as ADR 0003, applied one layer out:

* Passing `HandState` and trusting the policy not to read the secret fields **fails open**.
  The policy is correct today and one autocomplete away from incorrect, and the change that
  breaks it is made by someone with no reason to think about redaction.
* Passing a narrower type **fails closed**. The secret is not reachable, and TypeScript
  refuses to substitute a `HandState` where the policy input is expected.

Even the one field that *could* carry an opponent's cards does not: `SeatView.holeCards` is
`null` for every seat except the recipient's own, and only becomes non-null at a completed
showdown for seats that actually showed. A hand that ends in a fold reveals nothing, so a
policy cannot learn from the run-out whether the folder was bluffing — which is exactly the
information the game is played over.

### The test proves it by observation, not by inspection

Types are not proof, because a policy can be wrong within its own type — for instance by
receiving a legitimately-shaped object that a caller built from privileged data. So the
boundary is checked at runtime, in the manner of the engine's
`test/hidden-information.test.ts`:

The policy input is wrapped in a **`Proxy` that records every property path read** while the
policy runs. The test then asserts two things: that the recorded read set is a subset of the
permitted fields, and that no forbidden key — `deck`, `deckCursor`, `deckSalts`, another
seat's `holeCards` — was touched even once. A policy that reaches for a hidden field fails the
test by *doing it*, which is a stronger statement than a reviewer reading the code and
concluding it does not.

The companion assertion is cheaper and just as useful: run the same policy twice on the same
seed, once with the real `HandState` unavailable and once with an opponent's cards swapped for
different ones behind the redaction boundary, and assert the action sequence is identical. A
policy whose behaviour changes when an invisible card changes is reading something it must
not.

## 8. Difficulty: legibility, not handicapping

| Setting | Trait expression | Noise | Adapts | Equity samples | Coach during the hand |
| --- | --- | --- | --- | --- | --- |
| `educational` | 0.6, muted towards the baseline vector | 0.18 | no — `exploitativeAdaptation` is forced to 0 | 4,000 | yes |
| `realistic` | 1.0, as designed | 0.10 | yes | 8,000 | yes |
| `expert` | 1.0, as designed | 0.05 | yes | 12,000 | no — available afterwards in review |

**`educational` is more legible, not simply worse.** The distinction is the reason the setting
exists at all:

* **Muting pulls each trait towards the baseline vector, not towards 0.5.** Pulling towards
  0.5 would make every profile converge on the same middling style, which would defeat the
  point of an easier setting: the learner would face twelve identical opponents. Pulling
  towards the baseline keeps a profile leaning the way it is supposed to lean, just less far.
* **Adaptation is off entirely.** A profile that changes its strategy in response to you is
  hard to characterise, because the thing you are trying to observe keeps moving. With
  adaptation off, the style holds still long enough to be recognised.
* **Sizing is more uniform**, so a learner can practise the genuinely useful skill of reading
  strength from bet size — and then face `expert`, where sizing variance is high and that read
  stops working. Discovering that is the lesson.
* **The Coach stays available**, so the maths is visible while the shape of the strategy is
  being learned.

Higher noise at `educational` is the counter-intuitive part: the easiest setting is the *least
consistent* one. That is honest rather than accidental. Noise makes a profile easier to beat
and harder to read, which is why it is paired with muted traits and no adaptation — the style
is legible because it is simple, not because it is repetitive.

`expert` withdraws the Coach during the hand and returns it in review. That is not a
punishment; it is the only way to practise making a decision without the answer on screen and
still get the analysis afterwards.

## 9. The educational loop

Six steps, each mapped to a feature rather than to an intention.

| Step | Feature | What the learner sees |
| --- | --- | --- |
| **Play** | `POST` a legend match; it runs as an ordinary invite-only private room, so the table UI is unchanged | A seat plate with the display name, the archetype name and the disclaimers, always together |
| **Observe** | `ProfileObservedStats` from the learner's own session | VPIP, PFR, 3-bet, aggression, bluff, showdown and fold-to-bet frequencies, average bet size as a pot fraction — with a `confidenceHalfWidth`, so 40 hands are not over-read |
| **Calculate** | `CoachReport` at each decision | Clean and dirty outs, equity with its method named and its interval when sampled, pot odds and break-even equity, EV per legal action with the arithmetic, and the assumptions inline |
| **Compare** | `ComparedDecision` | The learner's action beside the model's, plus the other actions that were available with their EV — the shape of the decision rather than a verdict on it |
| **Explain** | `ModelReasoning` | `modelPreference` in the third person, the `drivingTraits` with their values, `whatChangedIt` (position, stack depth, price), and `actionProbabilities` before sampling |
| **Replay** | `HandComparison`, and `CompareProfilesResponse` for one spot against several profiles | Decision-by-decision commentary; and where profiles disagree, a takeaway that points at the disagreement instead of resolving it |

Two loop-closing features are worth calling out because they are unusual.

`LearnFromProfileResponse` puts the profile's **declared** traits next to what the learner
**actually observed** in their own session, and next to the axes where this profile differs
most from others. "Its card says it folds readily; over your 120 hands it folded to 61% of
river bets, plus or minus 9 points" is a complete probability lesson delivered by the product
doing its own job.

`ProfileStatsResponse.divergences` surfaces the axes where a large simulation **disagrees**
with the profile's declared trait. Not hidden, not smoothed: a model whose behaviour does not
match its own card is a defect, and showing it is how it gets fixed.

## 10. Strategy quality is never outcome

**A play is not good because it won or bad because it lost.** This is the property the whole
comparison feature is built around, and it is enforced structurally.

* `DecisionQuality` is computed **from EV, before the run-out is known**. Its inputs are
  `bestAvailableEv`, `chosenEv` and `evGivenUp` — all available at the moment of the decision.
* `HandComparison.chipResult` and `HandComparison.decisionQuality` are separate, unrelated
  fields. Neither is derived from the other, and the summary text must never explain one by
  the other.
* The band is qualitative — `consistent-with-analysis`, `slightly-off`, `materially-off` —
  because a precise score would imply more certainty than the model has. It is never a grade
  or a mark, and there is no field in which a decision can be labelled "correct" or "optimal"
  (`docs/PRODUCT-GUARDRAILS.md` §3).

**When result and quality disagree, the product says so out loud.**
`HandComparison.outcomeVersusQualityNote` is present whenever they point in opposite
directions — a well-played hand that lost, or a badly-played hand that won — and it is a
first-class field rather than an afterthought.

That note is the most valuable teaching moment in the feature. A learner who internalises
"this was the right call and it lost, and both of those things are true" has learned the
single most transferable idea in the entire syllabus. A product that quietly congratulated
them for winning with a bad call would be teaching the opposite, in a form they would remember
better.

It is also why `docs/PRODUCT-GUARDRAILS.md` §2 forbids near-miss celebration and streaks. A
lost hand is not dressed up as an almost-win, and the only thing the product ever celebrates
is reasoning.

## 11. Verification: what the statistical tests prove

The fast suite runs on every change; the statistical runs are separate
(`pnpm --filter @prl/poker-ai test:simulation`, with a long timeout, because tens of thousands
of hands per profile is minutes of CPU, not milliseconds).

### What is actually proven

| Claim | How |
| --- | --- |
| **Behaviour matches the card.** | Play many thousands of deterministic hands per profile and assert the observed VPIP, PFR, 3-bet, aggression, bluff, fold-to-bet and mean bet-size-as-pot-fraction land within a stated tolerance of the values derived from the declared traits. |
| **The profiles are distinguishable in play, not only on paper.** | A test asserts a floor on the minimum pairwise `traitDistance` that `profileDiversity()` reports; the simulation then asserts that the *observed* frequencies separate too, pair by pair, with a pooled two-proportion z-test (`stats.ts`) rather than by eyeballing two averages. A set that looked diverse on its cards and played identically fails. |
| **Decisions are probabilistic, not scripted.** | The same seat in the same situation, across seeds, produces more than one action, and the pre-sampling distribution has more than one non-zero entry wherever more than one action is legal. |
| **Determinism holds.** | Same profile, same difficulty, same seed, same situation produces an identical action sequence, run to run and machine to machine. |
| **Only legal actions are ever proposed.** | Every proposed action is drawn from `view.legalActions` and every size lies within the engine's `minTo`/`maxTo`, asserted across the whole simulation rather than spot-checked. The engine's own validation is the second line. |
| **The information boundary holds at runtime.** | The `Proxy` read-set assertion of §7, plus the invisible-card-swap invariance check. |
| **No string impersonates.** | Every profile string passes `findImpersonation` at module load, and every generated commentary string passes at generation time. The guard itself has a test proving it can fail, so a broken guard cannot pass silently. |
| **Difficulty does what it claims.** | `expressTraits` at `educational` produces traits strictly between the baseline and the profile's declared vector, with `exploitativeAdaptation` at exactly 0. |

### The denominators are part of the claim

A frequency without its denominator is not a measurement, and the *wrong* denominator quietly
measures something else entirely. So `packages/poker-ai/src/stats.ts` computes VPIP and PFR over
**preflop decisions offered** — hands in which that seat was to act at least once before the
flop — rather than over hands dealt.

A hand-history tracker divides by hands dealt, correctly, because it is describing a session. It
is the wrong denominator here: the button rotates, and heads-up a big blind whose opponent folds
preflop never acts at all. Divide by hands dealt and the figure becomes a blend of the policy's
entry threshold and the rate at which the table denied it a decision — so comparing it to
`traits.vpip` would be measuring button rotation and calling it a style. Every other rate states
its own denominator on the field, for the same reason.

The tolerances are justified the same way. At 8,000 observations the worst-case 95% half-width on
a proportion is `1.96 × 0.5 / sqrt(8000)` = 0.011, and every tolerance in `OBSERVABLE_AXES` is
larger than 0.02. None of them is absorbing sampling noise; each describes how *loosely the trait
is coupled to the statistic*, and each carries a `why` string saying so. That is the only defence
against the real failure mode, which is widening a tolerance until the suite goes green.

### What is *not* proven — precisely

* **Not that any profile plays well.** The suite checks that a model behaves as its card
  claims. It says nothing about whether the card describes a good strategy. A profile could
  match its declared traits perfectly and still be a losing player, and several deliberately
  are.
* **Not that any profile resembles any person.** There is no human data anywhere in this
  package, so no such claim is testable even in principle. The frequencies are measured
  against the profile's own declared parameters, and that is the only comparison being made.
* **Not that the trait-to-behaviour mapping is unique or correct.** Passing tolerances show
  the mapping is *consistent*; a different implementation could hit the same frequencies with
  different reasoning. The tests bound the mapping, they do not pin it.
* **Not that every axis is measured.** Only seven of the sixteen are frequencies a run can
  observe — `vpip`, `pfrShareOfVpip`, `aggressionFrequency`, `bluffFrequency`,
  `threeBetTendency`, `foldToPressure` and `betSizingPreference`, the set in `OBSERVABLE_AXES`.
  The other nine change real decisions but are not rates, so no single observed number is the
  same kind of quantity, and inventing a mapping for them would produce a table that looked
  complete and compared nothing. They are tested by their *effects* — a position-sensitive
  profile's entry rate differs by seat, a low-`sizingVariance` profile's bet sizes cluster —
  never by a declared-versus-observed row.
* **Not that a bluff is what a strong player would call a bluff.** The observer counts an
  aggressive action as a bluff when the holding makes no pair or better, so every semi-bluff
  counts, including a nut flush draw firing the flop. That is the right reading of
  `bluffFrequency` — "a hand that has little chance of winning at showdown" — and it is a
  definition, not a measurement, so the figure is only comparable to another figure computed
  the same way.
* **Not tight enough to catch every regression.** The tolerances are wide because the coupling
  between a trait and an observable rate is loose — not because the samples are small — and
  either way a real but modest behavioural drift can pass. Each one is stated with the reason for
  its width, which is what makes widening it a visible act.
* **Nothing about exploitability, equilibrium distance, or win rate against a competent
  human.** No profile is compared to a solver, because there is no solver here. See §12.
* **Not a guarantee about the impersonation guard's coverage**, only that the shapes it lists
  are rejected. §3 and §12 say what it misses.

## 12. Limitations

Stated without hedging, in the manner of `docs/THREAT-MODEL.md` §9.

| # | Limitation | Why accepted | What would change it |
| --- | --- | --- | --- |
| L1 | **These are coarse style approximations, not strong play.** A profile exists to be a recognisable style to practise against. | Strength is not the goal, and would make the teaching worse. A model that plays unreadably well teaches nothing about styles. | Nothing. This is the design, and the profile card says so. |
| L2 | **The profiles are NOT solver-derived. A strong human should beat all of them.** | Sixteen scalars and a scoring function cannot approach equilibrium play, and pretending otherwise would violate `docs/PRODUCT-GUARDRAILS.md` §3. | A solver, which is explicitly not wanted here (`docs/THREAT-MODEL.md` G6). |
| L3 | **A trait vector cannot represent everything real players do.** Missing entirely: multi-street planning (a size chosen now to set up a shove two streets later), table dynamics, meta-game history across sessions, image management, and deliberate strategy changes aimed at one opponent over hours. | Adding axes adds parameters faster than it adds legibility, and the vector's value is that it is small enough to show a learner in full. | More axes buys little; genuine multi-street planning needs a different model shape, not more numbers. |
| L4 | **The opponent model is simple frequency counting, not Bayesian inference.** It tallies public actions and forms ratios. It carries no prior, no posterior, no uncertainty on its own estimates, and it weights a 5-hand sample the same way it weights a 500-hand one. | It is legible, cheap, and its failure mode is honest: after a few hands, it is confidently wrong in an obvious way, which a learner can see and exploit. That is itself the lesson about small samples. | A Bayesian model with a stated prior and a decaying window. It would be better, and considerably harder to explain to a learner in a sentence. |
| L5 | **The range estimator maps one tightness number onto a range and ignores board texture.** `topPercentRange()` orders the 169 starting-hand classes by all-in equity against a random hand and takes the top slice. It does not know that a range which continues on a flush-draw board is not the same range that continues on a dry paired one, and it does not remove hands an opponent's earlier line rules out. | The alternative is a per-street range model, which needs assumptions a learner cannot audit, and range weighting is deliberately absent everywhere in this codebase for the same reason (`ranges.ts`). | Board-texture-aware range narrowing with its assumptions surfaced. Every figure derived from it would need to carry them. |
| L6 | **No claim is made that any profile is beatable — or unbeatable — at any level.** There is no "beat this profile to advance", no rating, and no measured win rate published for any profile against anything. | Such a claim would need a reference opponent to measure against, would be a ladder by another name, and ladders are banned (`docs/PRODUCT-GUARDRAILS.md` §2). | Nothing. This is deliberate. |
| L7 | **The impersonation guard is a pattern list, so it catches the shapes it knows.** It does not catch a proper noun followed by a mental-state verb, nor `he/she/they would <verb>` outside four listed verbs. It also over-rejects: it refuses any string containing the word "official". | A crude guard that errs towards rejection is the right trade — a false positive costs a rewording. The primary control is structural (§3): no template takes a person as its subject, and an attributed name is never interpolated into commentary. | Assert that no `naming.attributedName` string appears anywhere in generated commentary. The names are known data, so the check is cheap and much tighter than a verb list. |
| L8 | **The model's own read of its hand carries sampling error it does not surface to itself.** Strength assessment is bounded Monte Carlo — 4,000 to 12,000 samples by difficulty — so two runs of one spot can disagree slightly, and near a decision boundary that noise can flip an action. | It is a real budget constraint inside a live hand, and the effect is small next to the deliberate difficulty noise, which is larger by design. | A higher sample budget, or exact enumeration where the work fits (ADR 0005). Both cost latency inside a hand. |
| L9 | **No tilt, fatigue, emotion or session arc is modelled**, and a profile's traits never change: observation counters accumulate within a match, the vector that defines the style does not. | Deliberate, and it is a guardrail rather than a shortcut. Modelling a named person's emotional state is precisely the fabrication §3 exists to prevent. | Nothing, for any attributed profile. A purely archetypal "tilting player" style could be added without touching the impersonation boundary. |
| L10 | **Tournament instincts inherit the ICM model's approximations.** `tournamentOrientation` weights survival using Malmuth–Harville, which ignores skill, position and blind pressure (`docs/THREAT-MODEL.md` G7). | It is the standard teaching model and its assumptions are stated with every number it produces. | Nothing; the limitation is itself the teaching point. |
| L11 | **The attributed-name mode does not resolve name, image and likeness questions**, and this codebase cannot. Setting `PRL_LEGEND_NAMING=attributed` is a decision with legal consequences for the deployer. | The default is the safe mode, and the opt-in is where the question gets asked by a person. | A deployer obtaining permissions, which is outside the repository. |

## 13. Where to look first

| Question | File |
| --- | --- |
| How are profiles named, and what stops impersonation? | `packages/poker-ai/src/labelling.ts` |
| What are the sixteen axes, and what do they derive? | `packages/poker-ai/src/traits.ts` |
| What are the twelve profiles, and where did the numbers come from? | `packages/poker-ai/src/profiles.ts` |
| How is "it behaves the way its card says" measured, and over what denominator? | `packages/poker-ai/src/stats.ts` |
| What does the wire look like, and why is `disclaimers` required? | `packages/contracts/src/legends.ts` |
| Exactly what may a seat see? | `packages/poker-engine/src/redact.ts` |
| What is a legal action, and why? | `packages/poker-engine/src/betting.ts` |
| Where does the injected randomness come from? | `packages/poker-engine/src/rng.ts` |
| How is equity computed, exactly or sampled? | `packages/poker-math/src/equity.ts` |
| Why is the hand-strength ordering computed rather than copied? | `packages/poker-math/src/hand-ranking.ts` |
| Why styles rather than people? | [ADR 0011](adr/0011-strategy-profiles-not-celebrity-simulation.md) |
| Why probabilistic, and why no LLM? | [ADR 0012](adr/0012-probabilistic-policies-and-no-llm-in-the-loop.md) |
| What is *not* claimed? | §12 above, and `docs/THREAT-MODEL.md` §9 |
