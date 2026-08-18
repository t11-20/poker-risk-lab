# ADR 0012 — Probabilistic policies, and no LLM in the decision loop

**Status:** Accepted · **Date:** 2026-08-17

## Context

Each of the twelve strategy profiles (ADR 0011) has to turn a situation into an action, several
times per hand, inside a live table. Two questions had to be answered before a line of the
policy was written.

**How does a style choose?** The obvious implementation scores the legal actions and takes the
highest. That produces an opponent that is a puzzle rather than a player: identical situations
produce identical actions, so a learner who finds the seam plays against a lookup table for the
rest of the session. It also teaches something false by omission — that each spot has one action
a style would take — when the more useful truth is that several actions are often defensible and
strong players mix.

**Where does the reasoning come from?** A language model is an obvious candidate for something
that has to *look like* judgement and *explain itself* in prose. It is also the single most
consequential architectural decision in the feature, because a network call inside the game loop
changes what the product is: what can be tested, how fast a hand plays, what it costs to verify,
and how many trust boundaries the threat model has.

The constraints the answers had to satisfy were already fixed by the rest of the system. The
engine is a pure function of `(state, action)`. Monte Carlo takes an explicit seed so a teaching
scenario's figures are identical for every learner (ADR 0005). `Math.random` is banned in engine
code and a source scan asserts it is absent. Any decision that could not be reproduced from a
seed would be the first non-reproducible thing in the core.

## Options considered

**A. Deterministic argmax — score the legal actions, take the best.** Rejected. It is scripted
in everything but name. The same spot always produces the same action, so the opponent is
solvable by memory rather than by reasoning, and the product would be teaching that a style has
one answer per situation. It also throws away the most useful artefact of the calculation: the
*shape* of the decision, which is the thing worth showing a learner.

**B. Probabilistic sampling from `Math.random`.** Rejected. It fixes the teaching problem and
breaks everything else. Nothing is reproducible, so a statistical regression is a flake instead
of a bug; a teaching scenario deals differently for every learner; and a failing assertion
cannot be re-run. It is also banned in this codebase for exactly these reasons.

**C. Probabilistic sampling from an injected seeded `RandomSource` (chosen).**

**D. An LLM in the decision loop** — send the redacted view and let the model choose the action.
Rejected. Five reasons below; the fifth alone would be sufficient.

**E. An LLM outside the decision loop, generating commentary at runtime.** Rejected for this
release. It is a materially better idea than D and still wrong here: it puts unbounded generated
prose about a named strategy in front of a learner at runtime, where no review reaches it, and
the impersonation guard is a pattern list rather than a semantic filter — so it cannot be the
sole thing standing between a generator and a fabricated claim about a person (ADR 0011). It
also breaks exact replay, since a hand's commentary would no longer be reproducible from its
seed.

**F. A solved (equilibrium) strategy, sampling from its mixed frequencies.** Rejected on
educational grounds rather than technical ones. Equilibrium play is genuinely probabilistic, and
it is the wrong opponent for this product: it has no recognisable style to characterise, no
exploitable tendency to learn to attack, and no `counterStrategy` that could be written for it
truthfully. It would also invite exactly the claim `docs/PRODUCT-GUARDRAILS.md` §3 forbids.
Recorded as G6 in the threat model: a solver would make the teaching worse, not better.

## Decision

**Every policy computes a probability distribution over the legal actions and samples from it,
using an injected `RandomSource`. No LLM and no network call appears anywhere in the game
decision loop.**

* The candidate set is `view.legalActions` and nothing else; sizes are clamped to the engine's
  `minTo`/`maxTo`; the engine re-validates (ADR 0002).
* Scores become a normalised distribution, then one action is drawn from it. Difficulty adds
  bounded noise before normalising — 0.18 at `educational`, 0.10 at `realistic`, 0.05 at
  `expert`.
* **The pre-sampling distribution is part of the output.**
  `ModelReasoning.actionProbabilities` carries the probability of each action *before* the draw,
  and `CompareProfilesResponse.actionDistribution` reports it across many trials.
* Randomness is injected: `createSecureRandom()` in production, and
  `createDeterministicRandomForTests(seed)` — which refuses to run when
  `NODE_ENV === 'production'` — for tests, statistical runs and reproducible teaching scenarios.
  Any hand dealt from the deterministic source is permanently labelled in `randomSourceKind`.
* All decision-relevant maths is deterministic, bounded, and computed in-process from
  `@prl/poker-math`.

## Why probabilistic, in the terms that matter to a learner

**A learner can be shown the distribution.** This is the argument that decides it. "This model
bets 62% of the time here, checks 31%, and folds 7%" is a statement about strategy that a
learner can reason about, and it is on screen next to the action that was actually taken. An
argmax policy has no such number to show — it has a winner, which is a verdict.

Seeing that the spot had three plausible actions is the lesson. It transfers directly to the
learner's own play, where the useful question is rarely "what is the action?" and usually "which
actions are defensible, and how often?".

## Why no LLM in the decision loop

**1. Determinism and testability.** A seeded policy is a function: same profile, same
difficulty, same seed, same situation, same action, run to run and machine to machine. That is
what makes a statistical regression reproducible instead of intermittent, lets a teaching
scenario deal identically for every learner, and lets a failing assertion be re-run rather than
re-observed. An LLM is not a function of inputs under this repository's control — not seeded in
any way that survives a model version change, and providers deprecate versions.

**2. Action probabilities could not be stated.** The feature's most valuable output is the
pre-sampling distribution. A language model that returns "raise to 300" has no calibrated
distribution behind it. Asking it to *report* probabilities produces plausible numbers that are
not the frequencies with which it would actually act — which is worse than having none, because
it looks like data.

**3. Latency inside a live hand.** A bot action has to land in tens of milliseconds. A bounded
Monte Carlo of 4,000 to 12,000 samples is a known, in-process cost. A network round trip is
hundreds of milliseconds to seconds with a tail nobody controls, and a timeout mid-hand needs a
fallback policy — which means writing the deterministic policy anyway, and then shipping two
code paths where the less-tested one only runs when something is already going wrong. Having to
build the fallback is the argument: if the deterministic policy must exist and must be correct,
the model on top of it is added risk rather than added capability.

**4. Cost, at the scale verification requires.** Six-max means several bot decisions per street.
A statistical run plays tens of thousands of deterministic hands *per profile*, twelve profiles,
on every change to the package. That is hundreds of thousands of decisions per verification
run. Inference at that volume is not a line item, it is a reason to stop verifying — and a test
suite that is too expensive to run is a test suite that does not exist.

**5. The decisions could not be verified statistically the way these are.** This is the
decisive one. The core evidence that a profile is what its card claims is a test that plays
thousands of hands and asserts the observed VPIP, PFR, 3-bet, aggression and bluff frequencies
match the declared traits within a stated tolerance. That test is only meaningful against a
policy whose behaviour is a stable function of its parameters. Against an LLM there is no
declared trait vector to compare with, no guarantee the same prompt yields the same behaviour,
and no way to keep a passing assertion true across a model upgrade. The profile card would
become a claim with nothing behind it — which in an educational product is the one failure that
matters (`docs/THREAT-MODEL.md` T15).

**6. A trust boundary that does not need to exist.** The trust diagram has three zones —
untrusted clients, the server process, and the database (`docs/THREAT-MODEL.md` §3) — and
`redactFor()` is the only exit from the innermost box. Sending a live hand to an inference
provider would add a fourth zone and put a seat's hole cards through a second exit, which is the
one structural property the threat model is built around. The current design needs no API key, no
vendor, no rate limit, and cannot be interrupted by someone else's outage mid-hand.

## What is given up

Stated plainly, because it is a real loss.

**Richer natural-language commentary.** Commentary is assembled from templates over structured
facts — the driving traits, the price, the position, the stack depth, the distribution. It is
accurate, reproducible and reviewable, and it reads more uniformly than prose a language model
would produce. Specifically, what is lost:

* It cannot answer a free-form "but why not just call here?" in the learner's own framing.
* It cannot paraphrase the same idea twenty different ways, so a long session shows repeated
  phrasing.
* It cannot notice an unusual feature of a spot that no template anticipated.

Accepted, because the trade is a fluent unreviewable string for a plain reviewable one, and in a
product whose entire purpose is honest numbers with stated assumptions, the fluent one is the
more dangerous artefact. Structured reasoning also has a compensating property: because
`ModelReasoning` is data rather than prose, the UI can render the driving traits as the same
radar axes the profile card uses, and a learner can compare two decisions field by field.

## Consequences

* **Sampling must be injected everywhere.** A policy that reaches for `Math.random` is a defect,
  not a style issue. The engine's scan does not extend to it: that test reads the `src/` directory
  beside itself, so it covers `@prl/poker-engine` and nothing else, and `@prl/poker-ai` needs its
  own copy of the same check. Worth stating because the failure is silent — a scan pointed at the
  wrong package leaves the repository looking guarded while the new code is not.
* **Noise is a documented parameter with an educational effect**, not a constant buried in a
  function. `educational` is the *least* consistent setting, which is counter-intuitive and is
  explained rather than hidden (`docs/AI-LEGENDS.md` §8).
* **Replay is exact.** A seed reproduces the hand, the actions, the distributions and the
  commentary. That is what makes a Scenario Lab hand identical for every learner and a bug
  report actionable.
* **The mode runs fully offline.** No key, no vendor, no network, no hand data leaving the
  process.
* **Every commentary string is checked at generation time** by `assertNoImpersonation`, which is
  only a tractable guarantee because the string space is bounded by templates.
* **If natural-language commentary is ever wanted**, the only defensible place for it is
  out-of-band: over *completed* hands, generated at review time, cached, and human-reviewed
  before it reaches a learner. Never inside the decision loop, and never in the voice of a named
  person. That would need its own ADR and a threat-model review, because it introduces a new
  trust boundary and a new class of content the guard cannot fully police.
