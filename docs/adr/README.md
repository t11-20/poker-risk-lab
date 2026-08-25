# Architecture Decision Records

Each record captures one decision: the forces at the time, the options weighed, what was
chosen, and what it costs. They are written to be read by whoever has to change the
decision later, so the "Consequences" section is not decoration — it is the part that
tells you what breaks if you reverse it.

Records are immutable once accepted. A decision that changes gets a new record that
supersedes the old one, and the old one is marked. That history is the point.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-modular-monolith.md) | A modular monolith with a pure core | Accepted |
| [0002](0002-server-authoritative-engine.md) | The engine is the sole authority on legality | Accepted |
| [0003](0003-redaction-by-construction.md) | Redact by constructing a narrower type, not by deleting fields | Accepted |
| [0004](0004-merkle-deck-commitment.md) | Per-card Merkle commitment instead of hashing the deck | Accepted (supersedes the original hash-of-deck design — there is no `0004-draft` record and there never was) |
| [0005](0005-exact-then-monte-carlo.md) | Exact enumeration when it fits, bounded Monte Carlo otherwise | Accepted |
| [0006](0006-no-hardcoded-odds-in-content.md) | Content stores situations, never computed numbers | Accepted |
| [0007](0007-supply-chain-policy.md) | Release-blocking supply-chain gates | Accepted |
| [0008](0008-node-test-native-typescript.md) | `node --test` on native TypeScript, no test framework | Accepted |
| [0009](0009-whole-state-websocket-frames.md) | Send whole redacted state, not deltas | Accepted |
| [0010](0010-no-public-matchmaking-or-chat.md) | No public matchmaking and no free-text chat | Accepted |
| [0011](0011-strategy-profiles-not-celebrity-simulation.md) | Modelled strategy profiles, not celebrity simulation | Accepted |
| [0012](0012-probabilistic-policies-and-no-llm-in-the-loop.md) | Probabilistic policies, and no LLM in the decision loop | Accepted |
| [0013](0013-room-affinity-and-horizontal-scale.md) | Room affinity, and why horizontal scale is a protocol change | Accepted |
