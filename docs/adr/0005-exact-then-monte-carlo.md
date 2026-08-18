# ADR 0005 — Exact enumeration when it fits, bounded Monte Carlo otherwise

**Status:** Accepted · **Date:** 2026-08-17

## Context

Two known hands preflop is C(48,5) = 1,712,304 boards — exactly enumerable in about a
quarter of a second. A 200-combination range against a 300-combination range is 60,000
matchups × ~1.7M boards ≈ 10¹¹ evaluations, which is not.

An educational product must not present a sampled figure as if it were exact, nor pay for
exactness where it does not fit.

## Decision

`equity()` estimates the work first (`matchups × boardsPerMatchup`), enumerates
exhaustively below a budget (default 4,000,000), and otherwise runs bounded Monte Carlo.

**The result always names the method it used.** A Monte Carlo result always carries a 95%
confidence interval. Exact results carry `confidence: null`, because there is no sampling
error to report — not a fabricated zero.

## Supporting decisions

* **Deterministic sampling.** Monte Carlo takes an explicit seed and is fully deterministic
  for a given (spec, samples, seed). This is what lets the API shard across worker threads
  by seed and combine counts, and what makes a teaching scenario's figures identical for
  every learner.
* **Combining shards recomputes the interval from the pooled sample size** rather than
  averaging the shard intervals, which would understate it.
* **Matchups are enumerated with blockers respected.** An opponent cannot hold a card hero
  holds. Treating the ranges as independent is a common shortcut that measurably skews the
  answer and inflates the opponent's strong-combination count.
* **Ties award 1/k of the pot.** Equity is `wins + Σ(tie shares)`, not a win rate.
  Treating a chop as a loss is a small error preflop and a large one on paired boards.

## Verification

Equity was checked against a published result the implementation had no access to: AA vs
KK averaged over all 36 suit configurations comes out at **81.946%**, matching the widely
published ~81.9% figure, with individual configurations spanning 81.26%–82.64%. Monte
Carlo agrees with exact enumeration within its stated interval.

## Consequences

* The UI must always render the method and the interval. A bare percentage is a
  presentation bug, not a cosmetic one.
* The budget is a tuning knob with a real effect on latency; it is a parameter, not a
  constant buried in a function.
