# Poker Risk Lab — Architecture

**Version:** 1.0 · **Last reviewed:** 2026-08-17

This document explains the shape of the system and, more usefully, *why* it has that
shape. Where a decision has a real trade-off, the trade-off is named.

---

## 1. One sentence

A modular monolith: a pure rules-and-maths core, wrapped by a server-authoritative
Fastify API, rendered by a Next.js client that is never trusted with anything.

## 2. The layer that matters most

```
                     ┌───────────────────────────────────────────┐
                     │  PURE CORE — no I/O, no clock, no state    │
                     │                                            │
                     │   @prl/poker-engine    @prl/poker-math      │
                     │   ─────────────────    ────────────────     │
                     │   cards, evaluator     ranges, equity       │
                     │   CSPRNG shuffle       outs, odds, EV       │
                     │   Merkle commitment    fold equity, SPR     │
                     │   betting rules        variance, ICM        │
                     │   side pots            the Coach            │
                     │   state machine                             │
                     │   redaction boundary                        │
                     └────────────────────┬──────────────────────┘
                                          │ imported, never bypassed
                     ┌────────────────────▼──────────────────────┐
                     │  @prl/contracts — the wire contract        │
                     │  types · JSON Schemas · WS protocol        │
                     └───────┬────────────────────────┬──────────┘
                             │                        │
              ┌──────────────▼─────────┐   ┌──────────▼──────────────┐
              │  apps/api (Fastify 5)  │   │  apps/web (Next.js 16)   │
              │  auth · rooms · WS hub │   │  lessons · Scenario Lab  │
              │  bots · coach · review │   │  table · review · rooms  │
              │  MC worker pool        │   │  @prl/ui components      │
              └──────────┬─────────────┘   └──────────────────────────┘
                         │
                  ┌──────▼──────┐
                  │ PostgreSQL  │  schema `prl`, least-privilege role
                  └─────────────┘
```

**Everything hard is in the pure core.** The engine and the maths have no dependencies,
no I/O, no clock, no global mutable state, and no randomness except through an
explicitly passed source. That is not aesthetic preference — it is what makes the
correctness claims in `docs/VERIFICATION.md` possible. You can enumerate all
133,784,560 seven-card hands through the evaluator because it is a function. You can
replay 4,000 randomised hands asserting invariants after every action because
`applyAction` is a reducer. Neither would be practical against code that reached for a
database.

## 3. Why a modular monolith

The system has four deployable-looking pieces (rules, maths, API, web) and exactly one
that benefits from independent scaling (Monte Carlo). Splitting the rest into services
would buy nothing and cost the one property most worth having: **the game rules and the
server that enforces them are compiled together**, so a change to a betting rule cannot
be deployed to one and not the other.

Monte Carlo is handled with **worker threads inside the same process** rather than a
separate service. It is CPU-bound and stateless, so a thread pool gets the isolation
that matters (a long calculation cannot block the event loop and stall the tables)
without a network hop, a second deployment, or a second failure mode.

## 4. Package boundaries and what each one may not do

| Package | May depend on | Must never |
| --- | --- | --- |
| `@prl/poker-engine` | nothing | do I/O, read a clock, use `Math.random`, hold mutable module state |
| `@prl/poker-math` | `poker-engine` | do I/O, be non-deterministic without an explicit seed |
| `@prl/contracts` | `poker-engine` (types only) | contain runtime logic |
| `@prl/content` | `contracts`, `poker-engine` | contain a pre-computed odds figure |
| `@prl/ui` | `contracts`, `poker-math` | fetch data, hold app state, import `@prl/content` |
| `apps/api` | all packages | trust a client-supplied fact about game state |
| `apps/web` | `contracts`, `ui`, `poker-math` | import `@prl/content`, or compute anything authoritative |

Two of these are worth expanding.

**`@prl/content` is server-only.** It reads its JSON with `node:fs`. The browser gets
content over the API instead. This avoids the JSON-import spelling incompatibility
between Node's ESM resolver (`with { type: 'json' }`) and bundlers (which want it
absent), and it reflects the real requirement: content has to pass through the server
anyway to be merged with the caller's progress and to have its live figures computed.

**`@prl/ui` may import `@prl/poker-math`** so a component can format an already-computed
result, but it never *initiates* an authoritative computation. The Coach's numbers come
from the server; the client can recompute them for instant feedback, and the server's
answer wins.

## 5. Server authority, concretely

The rule is easy to state and easy to erode, so here is what it means in code.

A client message can only express **intent**:

```ts
{ type: 'action', actionId: '…', expectedSequence: 41, action: { type: 'raise', to: 300 } }
```

There is no message in the protocol in which a client states a card, a stack, a pot, or
whose turn it is. When that arrives, the server:

1. Loads its own `HandState`.
2. Calls `validateAction(state, seat, action)` — re-deriving the legal set from scratch.
   The buttons the client rendered are a convenience, never an authorisation.
3. Applies the action through the engine's reducer, which advances streets, runs out
   all-in boards, builds side pots and settles as a consequence of the action, so a
   hand cannot be left half-advanced.
4. Redacts the new state **per recipient** and sends each connection its own view.

`test/invariants.test.ts` asserts across thousands of random hands that a rejected
action leaves the state byte-identical. That is the property that makes step 2 more than
a comment.

## 6. The redaction boundary

`redactFor(state, { viewerSeat })` is the only exit from the server's inner trust zone.

It **constructs** a `PlayerView` rather than filtering a `HandState`. The distinction is
the whole design:

* A filter fails **open**. Add a secret field to `HandState` next year and a
  delete-based redactor silently starts leaking it.
* A constructor fails **closed**. The new field simply is not in `PlayerView` until
  someone deliberately adds it, and TypeScript will not let a `HandState` be passed
  where a `PlayerView` is expected.

`test/hidden-information.test.ts` backs this with runtime proof: it serialises every
view for every recipient at every point in a hand and asserts no hidden card and no
secret field appears anywhere in the object graph.

## 7. State: whole snapshots, not deltas

Every table update sends the **complete redacted view**, not a patch.

A delta protocol requires client and server to agree on a base state. Any disagreement
— a dropped frame, an out-of-order delivery, a reconnect at the wrong moment — produces
a table that is subtly wrong in a way that is extremely hard to reproduce or debug.
Sending the whole view costs a few kilobytes per update and removes the entire class of
bug. It also makes reconnect trivial: reconnect *is* "send the current view", with no
resynchronisation protocol to get wrong.

The cost is bandwidth, and it is the right trade for a six-max table.

## 8. Concurrency and idempotency

Two independent mechanisms, because they defend different failures:

* **`actionId`** — client-generated, stable across retries. A partial unique index on
  `(hand_id, action_id)` makes double application impossible **in the database**, which
  is what makes it hold under concurrent requests and not merely under sequential ones.
* **`expectedSequence`** — the sequence the client's view was at. A mismatch is rejected
  rather than applied. Silently applying it is the more dangerous outcome: the player
  folds a hand they believed they were raising.

Per-room serialisation is enforced by handling a room's actions through a single async
queue, so the engine's reducer is never re-entered concurrently for the same hand.

## 9. The Coach

The Coach is the product. At any decision it assembles, from the pure maths:

* **outs**, split into *clean* (hero becomes the likely winner) and *dirty* (hero
  improves but can still lose) — a distinction most material skips, and the reason
  learners miscount their real chances;
* **equity**, with the **method** named (exact enumeration or Monte Carlo) and, when
  sampled, a **95% confidence interval**;
* **pot odds** and break-even equity, and the surplus or shortfall against equity;
* **candidate EVs** per legal action, each with its derivation shown;
* **a suggestion** with a size *range*, a confidence level that may be `low`, the reason,
  and an explicit list of what would change it;
* **the assumptions**, always, never collapsed behind a toggle.

Three rules are enforced in the types themselves, not left to reviewer discipline:
`assumptions` is non-optional, `uncertainty` is non-optional, and there is no field in
which a suggestion can be labelled "correct" or "optimal".

## 10. Content: situations, not answers

Content stores **situations and reasoning**. It never stores a computed number.

A scenario says "hero holds Ah Kh, the board is Qh 7h 2c, the pot is 100, the opponent
bets 50, assume this range". It does not say "hero has 35% equity". Every figure the
learner sees is computed at runtime by `@prl/poker-math`.

Two reasons, and the second is the one that keeps it honest:

1. A hard-coded odds table is a lie waiting to happen. If it was wrong when written, or
   the maths changes underneath it, nothing catches the drift.
2. **Tests can verify content.** Because a scenario is a situation, the test suite
   computes the answer independently and asserts the teaching claim. A scenario whose
   `expectedInsight` stops being true fails the build.

The claims come in two flavours, and the distinction is documented rather than blurred:
*qualitative* claims (`equityExceedsBreakEven`, `callEvSign`) are genuine independent
checks on the teaching point; *quantitative* claims (`equityBetween`) are generated from
computed values and act as regression locks, not as independent verification.

## 11. Data model notes

Full schema in `db/migrations/`. The decisions worth knowing:

* **No deck, no salts, ever.** There is no column for them. A database read — a backup,
  a replica, an injection that reaches `SELECT` — cannot reveal the undealt cards of a
  live hand or the unshown holdings of a finished one, because the data is not there.
* **Hashes, not secrets.** Session tokens, invite codes, OIDC `state`/`nonce`/PKCE
  verifier, IPs and user agents are all stored hashed.
* **`rooms.visibility` is `CHECK`-constrained to `'invite_only'`.** Making the product
  public requires a migration and a review, not a config flag.
* **Two roles.** `prl_migrator` owns the schema; `prl_app` has DML only, no `CREATE`,
  `DROP` or `TRUNCATE`, and owns nothing.
* **No aggregate quiz score column.** Quizzes surface reasoning; they do not gate
  progress or manufacture a streak.

## 12. Toolchain choices

| Choice | Why | What it costs |
| --- | --- | --- |
| **`node --test` with native TypeScript** | Node 24 runs `.ts` directly, so the test runner is zero dependencies and there is no build step in the inner loop | Requires `erasableSyntaxOnly`: no enums, no namespaces, no constructor parameter properties |
| **`postgres` (porsager) over `pg`** | Zero dependencies, and tagged templates parameterise *by construction* rather than by discipline | Smaller ecosystem |
| **JSON Schema over a validation library** | Fastify already carries Ajv, so schemas validate at the framework boundary and cost no new dependency | Schemas are more verbose than a fluent builder |
| **Native CSS over Tailwind** | No build-time dependency, no class-name indirection, and theming via custom properties is genuinely simpler | Less terse than utility classes |
| **Merkle commitment over hash-of-deck** | Hash-of-deck cannot reveal without leaking unshown hands (see `docs/THREAT-MODEL.md` T2) | More code, and a proof per revealed card |
| **Whole-state WebSocket frames** | Removes the entire class of desync bugs; reconnect needs no protocol | More bandwidth per update |
| **`noUncheckedIndexedAccess`** | Every array read is checked, which caught real bugs during development | Verbose; drove the evaluator to integer bit-lanes, which turned out faster anyway |

## 13. Request lifecycles

**REST**

```
request → request-id → rate limit → CORS/Origin → CSRF (mutating) → Ajv schema
        → session lookup (hashed token) → handler → repository (parameterised SQL)
        → typed response  ·  no-store on authenticated responses
```

**WebSocket**

```
upgrade → Origin allowlist → session cookie → socket cap per session
        → hello (protocol version, room) → membership check → welcome + state
        → per-message: size cap, rate limit, Ajv validation, intent handling
        → engine → per-recipient redaction → frames out
```

**A hand**

```
startHand → CSPRNG shuffle → per-card Merkle commitment (root published)
          → antes (dead money) → blinds (live bets) → hole cards
          → betting rounds … → all-in run-out if no betting remains
          → showdown → side pots → awards
          → reveal ONLY the public positions (board + shown hands) with proofs
          → persist (never the deck, never the salts)
```

## 14. Failure behaviour

* **Config** is validated once at startup; the server refuses to boot rather than run
  half-configured, and reports every problem at once.
* **Unexpected errors** log full detail server-side and return `internal_error` with a
  request id — never a stack trace, an SQL fragment or an internal message.
* **The engine throws** on an illegal action rather than returning a sentinel, and the
  caller's state is untouched.
* **Pot construction is total.** A layer with no eligible winner returns the chips to
  their contributor instead of throwing mid-settlement. Legal play cannot produce that
  state, but returning the chips is the right answer if it ever arises, and it is a far
  better failure mode than aborting halfway through paying out a hand.
* **Graceful shutdown** stops accepting connections, drains in-flight requests within
  `SHUTDOWN_GRACE_MS` (default 10 s), closes the database pool and the equity worker pool, and
  exits 0. Non-zero means the drain actually failed or the grace expired — not merely that a
  request was in flight when the signal arrived.

  Two mechanisms make that true, and both are there because their absence was a real defect
  rather than a theoretical one. Fastify's `forceCloseConnections: 'idle'` drops only the sockets
  that are idle at the instant of SIGTERM, so a keep-alive socket that was mid-request survives
  and Node holds it for the full `keepAliveTimeout` — 72 s, well past any deployment's grace. The
  shutdown path therefore collapses `keepAliveTimeout` and sweeps for newly-idle sockets for the
  duration of the drain. And the worker pool is closed on the shutdown path itself rather than
  relying on a route module's `onClose` hook, because a process exiting with live worker threads
  does not exit at all — it hangs, and the only symptom is a stuck rollout.

  See `apps/api/src/server.ts` (`drainIdleConnections`, `shutdown`) and the comment on
  `forceCloseConnections` in `apps/api/src/plugins/security.ts`.

* **Only one API process may serve a room.** Live hand state is this process's memory
  (`rooms/registry.ts`, ADR 0001), so a second replica is not a scaling win but two different
  hands for one table. Deployment consequences — one replica, or room affinity — are in
  `docs/RUNBOOK.md` §11.1.

## 15. Where to look first

| Question | File |
| --- | --- |
| What is a legal action, and why? | `packages/poker-engine/src/betting.ts` |
| How are side pots built? | `packages/poker-engine/src/pots.ts` |
| What can a client see? | `packages/poker-engine/src/redact.ts` |
| How is the deal proved fair? | `packages/poker-engine/src/commitment.ts` |
| How is equity computed, exactly or sampled? | `packages/poker-math/src/equity.ts` |
| What does the wire look like? | `packages/contracts/src/` |
| What is enforced at the boundary? | `packages/contracts/src/schemas.ts` |
| Why is the supply chain locked down like this? | `docs/security/shai-hulud-snapshot-2026-08-17.md` |
| What is *not* protected? | `docs/THREAT-MODEL.md` §9 |
