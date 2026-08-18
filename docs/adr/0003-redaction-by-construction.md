# ADR 0003 — Redact by constructing a narrower type, not by deleting fields

**Status:** Accepted · **Date:** 2026-08-17

## Context

`HandState` contains the full deck, the read cursor, the per-card commitment salts, and
every seat's hole cards. Some subset of it must reach each client, and the subset differs
per recipient. Getting this wrong is the worst bug this system can have: it is silent,
irreversible for hands already played, and destroys the entire point of the product.

## Decision

`redactFor(state, { viewerSeat })` returns a **`PlayerView`** — a distinct, narrower
type built field by field. It does not clone `HandState` and delete keys.

## Why this specific shape

The two approaches differ in how they fail, and that is the whole argument:

* **Deleting fields fails open.** Add `deckSalts` to `HandState` next year and a
  delete-based redactor that never heard of it silently starts shipping it to clients.
  The change that breaks it is a change *elsewhere*, made by someone who had no reason to
  look at the redactor.
* **Constructing a narrower type fails closed.** The new field simply is not in
  `PlayerView` until somebody deliberately puts it there — and TypeScript refuses to
  substitute a `HandState` where a `PlayerView` is expected, so the mistake cannot be
  made accidentally at a call site either.

Types alone are not proof, because a redactor can be wrong within its own type. So
`test/hidden-information.test.ts` adds runtime evidence: it serialises every view for
every recipient at every point in a hand and asserts that no hidden card and no secret
field appears anywhere in the object graph.

## Consequences

* Adding a field to the client's view is a deliberate two-place change. That friction is
  the feature.
* `redactFor` is the highest-review-priority function in the codebase. Any change to it
  triggers a threat-model review (`docs/THREAT-MODEL.md` §10).
* `cardsHiddenFrom(state, seat)` exists purely so the tests can state the property
  positively rather than trusting the implementation to be its own oracle.
