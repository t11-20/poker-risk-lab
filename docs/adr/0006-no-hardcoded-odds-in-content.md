# ADR 0006 — Content stores situations, never computed numbers

**Status:** Accepted · **Date:** 2026-08-17

## Context

Teaching material is full of numbers: equities, out counts, break-even percentages. The
easy approach is to write them into the lesson text.

## Decision

**Content stores situations and reasoning. It never stores a computed figure.**

A scenario records "hero holds Ah Kh, board Qh 7h 2c, pot 100, opponent bets 50, assume
this range". It does not record "hero has 35% equity". Every number the learner sees is
computed at runtime by `@prl/poker-math`.

Quantities that *define* the situation — stacks, blinds, pot size, bet size, card
identities — are of course stored; they are the input, not the answer.

## Why

1. **A hard-coded figure is a lie waiting to happen.** If it was wrong when written, or
   the maths improves underneath it, nothing detects the drift. The content and the engine
   can disagree forever and the learner is taught whichever is wrong.
2. **Tests can verify content.** Because a scenario is a situation, the test suite computes
   the answer independently and asserts the teaching claim. This is the part that makes the
   decision worth its cost.

## The two kinds of claim, kept distinct

* **Qualitative** — `equityExceedsBreakEven`, `breakEvenExceedsEquity`,
  `callEvSign`, `cleanOutsEquals`. These are genuine independent checks: an author
  asserts a teaching point, and the maths confirms or refutes it. A wrong claim fails the
  build.
* **Quantitative** — `equityBetween`, `sprBetween`, `ruleOf24ErrorAtMost`. These are
  generated from computed values and act as **regression locks**, not independent
  verification. Pretending otherwise would overstate the guarantee, so the distinction is
  documented wherever the claims appear.

`cleanOutsEquals` is rejected by the validator unless the opponent is an *exact* hand,
because against a range the out count depends on which hand in the range is held.

## Consequences

* Prose must describe relationships ("you need roughly a quarter of the pot in equity")
  rather than assert figures. Approximations explicitly labelled as such — the rule of 2
  and 4 is itself a lesson — are fine.
* Rendering a lesson requires computation, so content is served through the API rather
  than shipped as a static bundle.
* Authoring is harder. That is the trade, and it is worth it.
