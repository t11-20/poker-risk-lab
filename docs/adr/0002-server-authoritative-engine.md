# ADR 0002 — The engine is the sole authority on legality

**Status:** Accepted · **Date:** 2026-08-17

## Context

A client can be modified. Every button, every disabled state, every bet-size clamp in the
browser is a suggestion an attacker can ignore. The question is where the real decision
about legality lives, and how to stop that decision from quietly drifting into two places.

## Decision

`@prl/poker-engine` is the **only** definition of what is legal. Specifically:

* `legalActions(state, seat)` produces the complete legal set with exact bounds.
* `validateAction(state, seat, action)` re-derives that set server-side on every
  submission and throws on anything outside it.
* The client renders from the same function's output, so the two cannot disagree — but the
  client's rendering is a **convenience, never an authorisation**.
* No protocol message lets a client state a card, a stack, a pot, or whose turn it is.
  A client can only express intent.

## Consequences

* A tampered client gains nothing. It can send an illegal action; it will be rejected.
* Rejection must be **total**: a rejected action leaves the state byte-identical.
  `test/invariants.test.ts` asserts this across thousands of randomised hands, because a
  partially-applied rejection is worse than an accepted illegal action — it is a
  corruption nobody notices.
* The engine's error messages are user-facing, so they are written for players
  ("you may not raise: the last increase was a short all-in, so you may only call or
  fold") rather than for developers.
* Duplicating a rule in the client for responsiveness is forbidden. The client may
  *display* a computed figure early; it may not decide anything.
