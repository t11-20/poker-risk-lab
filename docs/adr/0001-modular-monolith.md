# ADR 0001 — A modular monolith with a pure core

**Status:** Accepted · **Date:** 2026-08-17

## Context

The system has four natural pieces: the rules of poker, the probability maths, a server
that enforces the rules, and a web client. Only one of them — Monte Carlo equity — has a
scaling profile different from the rest.

The obvious modern instinct is to split these into services. The obvious alternative is
one process.

## Decision

**A modular monolith.** Independent, dependency-free packages (`poker-engine`,
`poker-math`, `contracts`, `content`, `ui`) consumed by two applications
(`apps/api`, `apps/web`) that deploy as single units.

Monte Carlo runs in **worker threads inside the API process**, not as a separate service.

## Options considered

**A. Services per domain (rules service, maths service, game service).** Rejected. It
would separate the game rules from the server that enforces them, making it possible to
deploy a betting-rule change to one and not the other. That is the single worst failure
mode available to this system, and a service boundary invites it.

**B. Monolith with everything in one package.** Rejected. The correctness work depends on
the engine and the maths being *pure* — no I/O, no clock, no ambient state. Package
boundaries with declared dependencies are what make that enforceable rather than
aspirational. `@prl/poker-engine` has zero dependencies, and that is checkable.

**C. Modular monolith (chosen).**

**D. Monte Carlo as its own service.** Rejected. It is CPU-bound and stateless. Worker
threads give the isolation that actually matters — a long calculation cannot block the
event loop and stall live tables — with no network hop, no second deployment and no
second failure mode.

## Consequences

* The API and web apps each scale as a unit. For a six-max invite-only product that is
  ample; if a public product ever shipped, the tables would be the piece to extract, and
  the package boundaries are already where the seam would go.
* Package purity is load-bearing. Anything that adds I/O to `poker-engine` or
  `poker-math` breaks the exhaustive verification strategy, not just style.
* A single `pnpm build` produces everything, and one lockfile covers the whole system —
  which the supply-chain policy depends on.
