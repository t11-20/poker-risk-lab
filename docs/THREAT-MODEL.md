# Poker Risk Lab — Threat Model

**Version:** 1.0 · **Last reviewed:** 2026-08-17

This document says what the system is trying to protect, from whom, and how — and
it says plainly where it falls short. A threat model that lists only the threats it
happens to have mitigated is marketing. Section 9 is the honest part.

---

## 1. What this system is

An educational, **play-money** No-Limit Texas Hold'em app. Users read lessons, work
through scenarios, play against bots, and play private invite-only tables with people
they already know.

**Chips are "units": free, resettable, and valueless.** There is no purchase path, no
cash-out, no transfer between accounts, no prize, and no external redemption. That is
a security-relevant fact, not just a product one: it removes the financial motive that
drives most attacks on real poker platforms, and it is why several classically severe
threats (collusion for profit, bot farms, money laundering through chip dumping) are
rated lower here than they would be for a real-money product.

It is *not* a reason to be careless. The remaining motives — winning a private game
against friends, embarrassing someone, harvesting credentials from the host, using the
server as free compute — are entirely sufficient.

## 2. Assets, in priority order

| # | Asset | Why it matters | Impact if lost |
| --- | --- | --- | --- |
| A1 | **Hidden card information** (hole cards, undealt deck order, commitment salts) | The entire game is played over this information. A leak makes every hand meaningless and is irreversible for hands already played. | Critical |
| A2 | **Session integrity** | A stolen session lets an attacker act as a player: fold their hand, dump their units, read their private tables. | High |
| A3 | **Server authority over game state** | If a client can influence stacks, pots, turns or legal actions, the game is not a game. | High |
| A4 | **Host credentials and the supply chain** | The Mini Shai-Hulud campaign's whole purpose is stealing developer and CI credentials. A compromise here is far worse than anything in-game. | Critical |
| A5 | **Correctness of the teaching material** | Confidently teaching wrong probability is the product failing at its only job. | High |
| A6 | **User account data** (display name, OIDC subject, progress) | Minimal by design, but still personal data. | Medium |
| A7 | **Availability** | An unavailable lab is an inconvenience, not a loss. | Low–Medium |

Note what is **not** on this list: there is no balance of value to steal, no payment
instrument, and no PII beyond a display name and an OIDC subject identifier. The data
minimisation is deliberate — see §7.

## 3. Trust boundaries

```
┌─────────────────────────────────────────────────────────────────────────┐
│ UNTRUSTED                                                               │
│   Browser (React) ── every byte from here is attacker-controlled         │
│   Other players at a private table                                      │
│   The public npm registry and every package in it                        │
│   The OIDC provider's responses (verified, not trusted)                 │
└────────────────────────────────┬────────────────────────────────────────┘
                    HTTPS + WSS  │  cookie-authenticated, Origin-checked
┌────────────────────────────────▼────────────────────────────────────────┐
│ TRUSTED — the Fastify server process                                    │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │ HIGHEST TRUST — in-process, never serialised outward             │  │
│   │   HandState.deck, deckCursor, deckSalts                         │  │
│   │   every seat's holeCards                                         │  │
│   │   session signing secret, OIDC client secret                     │  │
│   └──────────────────────────────────────────────────────────────────┘  │
│   redactFor() is the ONLY exit from that inner box                      │
└────────────────────────────────┬────────────────────────────────────────┘
                  parameterised  │  least-privilege role (prl_app)
┌────────────────────────────────▼────────────────────────────────────────┐
│ SEMI-TRUSTED — PostgreSQL                                               │
│   Stores no deck, no salts, no session tokens, no raw IPs                │
└─────────────────────────────────────────────────────────────────────────┘
```

The single most important structural decision: **the deck and the salts never reach
the database.** A database read — a backup, a compromised replica, a curious operator,
an SQL injection that gets as far as `SELECT` — therefore cannot reveal the undealt
cards of a live hand or the unshown holdings of a finished one. There is no column to
read. `db/migrations/0001_initial.sql` carries a comment saying so, so a future
maintainer does not "helpfully" add one.

## 4. Adversaries

| Adversary | Capability | Motive |
| --- | --- | --- |
| **AD1 — Cheating player** | Full control of their own client, can read all traffic to it, can open many sockets, can collude out-of-band with another player at the table | Win the private game |
| **AD2 — Curious/abusive player** | Same, plus a friendship with the target | Read someone's cards, grief, impersonate |
| **AD3 — Remote unauthenticated attacker** | Can reach the public endpoints | Take over accounts, enumerate rooms, use the server as compute, deface |
| **AD4 — Supply-chain attacker** | Can publish a package version, or compromise a maintainer account | Steal CI/developer credentials, establish persistence |
| **AD5 — Malicious insider / operator** | Database and host access | Read hidden cards, rig deals |
| **AD6 — Automated scanner / botnet** | High-volume, low-sophistication | Opportunistic exploitation, resource abuse |

## 5. Threats and controls

Severity is (likelihood × impact) **for this play-money product**.

### T1 — Reading another player's hole cards · Severity: Critical

*The defining threat. Everything else is secondary.*

**Controls**

1. **A separate type, not a filtered one.** `redactFor()` in
   `packages/poker-engine/src/redact.ts` does not take a `HandState` and delete
   fields. It constructs a `PlayerView`, a narrower type listing only what a client
   may see. This is the difference between failing open and failing closed: add a
   secret to `HandState` later and a delete-based redactor silently starts leaking it,
   while a construct-based one simply does not carry it, and TypeScript refuses to
   substitute one type for the other.
2. **Runtime proof, not a code review.** `test/hidden-information.test.ts` serialises
   every view for every recipient at every point in a hand and asserts that no hidden
   card and no secret field appears — including the case that actually caught a real
   bug during development (see §5, T2).
3. **Visibility rule.** A hole card is visible only to its owner, or to everyone once
   the hand is complete *and* that seat appears in the showdown list. A hand that ends
   by folding produces an empty showdown list, so nobody's cards are revealed — which
   also protects the strategically significant fact of whether a folder was bluffing.
4. **Per-recipient sockets.** Each connection gets its own redacted view; there is no
   broadcast of a shared state object that individual clients then filter. Client-side
   filtering of privileged data is not a control at all.

**Residual risk.** A logic error inside `redactFor` itself. Mitigated by the runtime
tests, but this is the function to review most carefully in any change.

Since 2026-08-27 the web client also *notices* one. `apps/web/src/lib/hole-card-entitlement.ts`
holds every `state` frame to the invariant `redactFor`'s own header states about its output —
`holeCards` non-null for exactly `isSelf || showed down`, with `viewerSeat`, `isSelf`, `street` and
`result.showdowns` all published in the same view — and refuses the frame, raises a `console.error`
and tells the reader when it does not hold. Note what that is and is not, because point 4 above is
still true and this does not soften it: it is a **smoke detector, not a control**. The bytes have
already reached the browser by the time it runs and it cannot recall them; the client deliberately
does not filter the cards out, because filtering would hide a real leak from the honest reader
while leaving it in the network panel for the dishonest one. What it buys is that the defect stops
being silent. `apps/web/test/hole-card-entitlement.test.ts` is the gated evidence, with its negative
control recorded in its header; `scripts/smoke-test.mjs` asks the same question of the API's own
bytes against a deployment, and is unaffected by anything the client does.

### T2 — Post-hand verification leaking unshown hands · Severity: High → mitigated by redesign

This one is recorded because it *happened*, and because the fix is the interesting part.

The first commitment design was the obvious one: `commitment = SHA-256(salt ‖ deck)`,
published before the deal, with the salt and deck revealed afterwards so anyone could
recompute the hash and confirm the deal had not been altered mid-hand.

A hidden-information test failed, and it was right to: **revealing the deck reveals all
52 cards**, including the hole cards of every player who folded without showing. In a
heads-up fold, that is the winner's exact hand. The integrity control would have
created an information leak strictly worse than the problem it solved.

**The fix** (`packages/poker-engine/src/commitment.ts`): a **per-card Merkle tree**.
Each deck position is a salted leaf; the published commitment is the Merkle root. After
the hand, the server reveals a leaf — position, card, salt, and six sibling hashes —
for **only** the cards that legitimately became public: every board card, and the hole
cards of seats that actually showed. Every other leaf stays sealed.

Design details that are load-bearing:

* **Per-card 32-byte salts.** A card is one of 52 values, so an unsalted leaf hash is
  brute-forced instantly and would leak its card to anyone holding the root.
* **Domain-separated leaf and node hashing** (`0x00` prefix for leaves, `0x01` for
  internal nodes) to prevent the classic Merkle second-preimage attack where an
  internal node is passed off as a leaf.
* **Context binding.** The room id, hand number and hand id are hashed into every
  leaf, so a commitment from one hand cannot be replayed as the commitment for another.
* **Permutation checking on verify.** A reveal claiming the same card at two positions
  is rejected before the hashes are even compared.

**Lesson recorded:** an integrity mechanism can create a confidentiality hole. The two
properties have to be designed together.

### T3 — A client dictating game state · Severity: High

**Controls.** The engine (`@prl/poker-engine`) is the sole authority on legality, and
it is a pure function of `(state, action)`. A client message can only express *intent*
(`{type: 'action', action: {type: 'raise', to: 300}}`); there is no message in which a
client states a card, a stack, a pot, or whose turn it is. `validateAction` re-derives
the legal action set server-side and rejects anything outside it — the client's rendered
buttons are a convenience, never an authorisation. `test/invariants.test.ts` asserts
across 4,000 randomised hands that a rejected action leaves the state byte-identical,
so a malformed request cannot nudge a hand forward.

### T4 — Replayed or duplicated actions · Severity: Medium

A dropped response, a reconnect mid-request, or an impatient double-tap could otherwise
apply an action twice, or apply it to a hand that has moved on.

**Controls.** Two independent mechanisms:

* **Idempotency.** Every action carries a client-generated `actionId`. A partial unique
  index on `(hand_id, action_id)` makes double application impossible *at the database
  level*, not merely in application logic — which is what makes it hold under
  concurrent requests rather than only under sequential ones.
* **Optimistic concurrency.** Every action carries `expectedSequence`. If the hand has
  advanced, the action is rejected with `stale_action_sequence` rather than applied to
  a situation the player never saw. Silently applying it would be the more dangerous
  outcome: the player folds a hand they thought they were raising.

### T5 — Session theft and CSRF · Severity: High

**Controls.** `HttpOnly` (no JavaScript access, so XSS cannot exfiltrate it), `Secure`,
`SameSite=Lax`, `__Host-` prefix in production (which pins the cookie to the exact host
and forbids a `Domain` attribute, defeating subdomain-based fixation), and signing with
a secret the server refuses to boot without in production. Only a SHA-256 hash of the
session token is stored, so a database leak does not yield usable sessions.

CSRF uses double-submit with an `x-csrf-token` header on every state-changing method.
`SameSite=Lax` rather than `Strict` is a deliberate trade-off: `Strict` breaks the OIDC
redirect return, and the CSRF header covers what `Lax` does not.

### T6 — WebSocket cross-origin abuse · Severity: High

The browser same-origin policy **does not apply to WebSockets**, and cookies are sent
on the upgrade request. Without an explicit check, any web page could open an
authenticated socket to a user's table — "cross-site WebSocket hijacking".

**Controls.** The `Origin` header is checked against an allowlist during the upgrade
and the socket is closed with `4406` on mismatch. Authentication comes from the session
cookie, not from a token in the first frame — a token in a frame ends up in client-side
logs and error reports far more readily than an `HttpOnly` cookie does.

### T7 — Resource exhaustion through the Monte Carlo endpoints · Severity: Medium

Equity calculation is the one place where a small request buys a lot of CPU. A single
`POST /api/v1/math/equity` with six range-vs-range opponents and a huge sample count
could occupy a core for minutes.

**Controls.** The sample ceiling and the opponent count are in the **JSON Schema**, so
they are enforced at the framework boundary rather than by a check a handler might
forget. Long computations run in bounded worker threads with a wall-clock timeout, so
they cannot block the event loop and starve the tables. Coach requests are separately
rate-limited per session.

### T8 — Room enumeration and uninvited joining · Severity: Medium

**Controls.** Only invite-only rooms exist; `rooms.visibility` has a `CHECK` constraint
permitting exactly one value, so "just add a public flag" requires a migration and a
review rather than a config change. Invite codes are stored **hashed**, generated from
the CSPRNG, and are returned exactly once at creation — a database leak yields no usable
codes. Both "room does not exist" and "you may not see this room" return the same
`room_not_found_or_not_permitted`; a distinguishable response would let anyone
enumerate private tables one request at a time. Join attempts are rate-limited.

### T9 — Supply-chain compromise · Severity: Critical

The most serious threat to this repository, and the least game-specific. See
`docs/security/shai-hulud-snapshot-2026-08-17.md` for the advisory snapshot the
controls are built against.

**Controls** (all release-blocking, all in `pnpm run security:audit`):

| Control | Breaks |
| --- | --- |
| `ignoreScripts: true`, `onlyBuiltDependencies: []` | Both documented Mini Shai-Hulud delivery paths (`preinstall`/`postinstall`/`prepare`) |
| No git/tarball/remote dependency resolutions | The poisoned-git-dependency path |
| `minimumReleaseAge: 10080` (7 days) | Newly published malicious versions, during the reporting window |
| Exact versions + frozen lockfile | Unreviewed version drift |
| Lockfile↔registry integrity cross-check | A replaced tarball |
| Deny-list (`keyv`, `cacheable`, `flat-cache`, `file-entry-cache`, `cacheable-request`, `cache-manager`, `@cacheable/*`, `@antv/*`, …) | Known-compromised families |
| IOC sweep of the tree **and** the installed store | On-disk persistence, including `.claude/setup.mjs` |
| Quarantined acquisition (`pnpm run deps:quarantine`) | Credential theft *during* resolution |
| Source-encoding gate | Hidden characters and NUL bytes in source |
| CI actions pinned to 40-hex commit SHAs; base images pinned by `@sha256:` digest (`ci-pinning` gate, added 2026-08-19) | An upstream repointing a tag — `actions/cache@v4` is a pointer, and the campaign compromised GitHub Actions and Docker images as well as npm |
| Only declared workflow files may exist (same gate) | An **injected** workflow. `.github/workflows/codeql.yml` is a named campaign IOC: the worm squats on a filename a reviewer expects to see |

**Deliberately not treated as a control: npm provenance attestations.** The campaign
forges Sigstore attestations. The audit *records* attestation state for incident
response but the gate does not rely on it. Treating "has provenance" as "is safe" would
be exactly the wrong lesson from this campaign.

### T10 — A rigged deal by the operator · Severity: Medium (partially mitigated)

**Control.** The pre-hand Merkle commitment proves the deck order was fixed **before
any player acted**. A server that re-ordered undealt cards mid-hand to hit a draw,
break a cooler or protect a bot could not produce valid proofs.

**Not controlled — stated plainly.** The server generates both the deck and the salts,
so a dishonest operator can grind many candidate decks and commit to a favourable one
*before* dealing. The commitment cannot detect that. Ruling it out needs entropy the
server cannot predict — a multi-party commit-reveal in which each seated player
contributes a committed nonce that is mixed into the shuffle seed. That is not
implemented. It is **accepted risk**, recorded here and in the commitment module's own
header comment, rather than obscured behind the word "provably fair".

### T11 — Collusion between players at a private table · Severity: Low (by design)

Two players sharing hole cards over another channel gain a real edge, and no server
control can prevent out-of-band communication.

**Why it is rated Low here.** Tables are invite-only among people who already know each
other, and there is nothing to win. There is no matchmaking that could seat a colluding
pair against a stranger — and there will not be until moderation and anti-abuse review
pass, which is why `visibility` is constrained at the schema level.

### T12 — Abuse through user-supplied text · Severity: Medium

**Controls.** There is **no free-text chat**, deliberately, until moderation and
anti-abuse reviews pass. The only user-supplied text is a display name and a room name,
both length-limited and pattern-restricted to exclude control characters, bidi
overrides and zero-width characters — the mechanisms used to impersonate another player
or to corrupt a log line. React escapes by default and `dangerouslySetInnerHTML` is a
Biome error. Display names are excluded from logs.

### T13 — SQL injection · Severity: High if present

**Controls.** The `postgres` driver's tagged templates parameterise by construction —
`sql\`... ${value}\`` cannot interpolate a value into the statement text. The only
permitted `.unsafe()` use is whole-file DDL in the migration runner, documented at the
call site. The runtime role (`prl_app`) has no `CREATE`, `DROP` or `TRUNCATE` and owns
nothing, so even a successful injection is bounded to DML on the tables the app already
touches.

### T14 — Open redirect via the OIDC return path · Severity: Medium

**Controls.** The `redirectAfter` parameter accepts a **path only** — the schema pattern
rejects absolute URLs, protocol-relative `//evil.com`, and backslash variants. Sign-in
flows are the classic place an open redirect gets weaponised for phishing, because the
user has just been asked to trust the page. `state`, `nonce` and the PKCE verifier are
stored **hashed**, single-use, and expiring.

### T15 — Teaching something false · Severity: High

Unusual to find in a threat model, but this is an educational product and a confident
wrong number is the product failing at its purpose.

**Controls.**

* **No hard-coded odds anywhere.** Content stores *situations*; every figure is computed
  at runtime by `@prl/poker-math`. A stale or wrong constant cannot survive in content
  because there are no constants to be wrong.
* **Exhaustive verification of the foundation.** The hand evaluator is checked against
  all 2,598,960 five-card hands and all **133,784,560** seven-card hands, matching the
  published category frequencies exactly. Equity is cross-checked against known results
  (AA vs KK averaged over all 36 suit configurations comes out at 81.946%, matching the
  published figure).
* **Machine-checked teaching claims.** Each scenario carries `expectedInsight` claims
  that the test suite verifies against computed maths. If a scenario's teaching point
  stops being true, the build fails rather than the learner being misled.
* **Assumptions and uncertainty are never optional.** Every figure carries its
  assumptions and, when sampled, its confidence interval. The Coach's suggestion is
  never labelled "correct" or "optimal", and always lists what would change it.

### T16 — Timing side channels · Severity: Low

**Controls.** Session token and invite-code comparisons use constant-time comparison on
hashes. Room lookup returns the same error and comparable timing whether or not the room
exists.

## 6. Randomness

Cards come only from `node:crypto`'s CSPRNG. Index selection uses **rejection
sampling**: `x % 52` on a uniform 32-bit draw is not uniform, because 52 does not divide
2³², and the low indices would be very slightly favoured. The rejection probability is
about 1.1 × 10⁻⁸, so the loop effectively never iterates — but the guarantee is exact
rather than approximate.

The shuffle is Fisher–Yates drawing from the *unshuffled prefix* `[0, i]`, which is what
makes all 52! orderings equally likely; drawing from `[0, n)` instead is the classic bug
and produces a measurably biased deck. `test/rng.test.ts` asserts the uniformity of all
six orderings of three items to within 5%, which catches exactly that error.

`Math.random` is banned; a source scan asserts it does not appear in engine code, and
the scan has its own test proving it can fail. The deterministic generator used for
tests and reproducible teaching scenarios throws if `NODE_ENV === 'production'`, and any
hand it deals is permanently labelled `deterministic-test-only` or
`fixed-deck-scenario` in `randomSourceKind`.

## 7. Data minimisation

Not collected: real name, email (beyond an opaque OIDC subject), payment details,
location, device fingerprint.

Stored hashed, never in the clear: session tokens, invite codes, OIDC `state`/`nonce`/
PKCE verifier, IP addresses, user agents.

Never stored at all: deck order, commitment salts.

Guests are first-class — the product is fully usable without any external identity.

## 8. Detection and response

* Structured logs with a request id on every line and a redaction list covering
  cookies, authorization, CSRF tokens, invite codes, OIDC codes and any key matching
  `/token|secret|password|cookie|authorization|invite/i`.
* `prl.audit_log` records security-relevant events.
* An SBOM (CycloneDX 1.6) is generated from the lockfile with per-artefact integrity
  hashes and is byte-stable across runs, so `git diff` shows dependency changes rather
  than a fresh timestamp.
* A scheduled daily supply-chain audit catches an advisory disclosed against an
  already-pinned dependency without waiting for a push.

**If a supply-chain compromise is suspected:** rotate every credential reachable from
CI and from developer machines (the payload reads runner memory, so masked secrets are
also exposed); check for the §3 IOC artefacts including `.claude/setup.mjs` and
`.vscode/setup.mjs`; audit for repositories carrying the campaign fingerprint; then
pin known-good versions and re-run the audit.

## 9. Accepted risks and known gaps

Stated without hedging.

| # | Gap | Why accepted | What would close it |
| --- | --- | --- | --- |
| G1 | **A dishonest operator can grind a favourable deck before committing** (T10) | Correctly closing it needs a protocol change, not a patch | Multi-party commit-reveal with player-contributed nonces mixed into the shuffle seed |
| G2 | **Out-of-band collusion is undetectable** | No server control can see another channel; there is nothing to win | Collusion analytics — only worth building if public matchmaking ever ships |
| G3 | **No public matchmaking, so no anti-abuse system exists** | Deliberate: shipping matchmaking without moderation would be the mistake | Moderation tooling, reporting, rate/reputation systems — all reviewed before the `visibility` constraint is relaxed |
| G4 | **No free-text chat** | Same reasoning | Moderation pipeline |
| G5 | **The a11y audit does not run a real browser** | A headless browser needs a large dependency with install scripts, which the supply-chain policy forbids | A separately-managed, quarantined browser runner in CI |
| G6 | **Bot policies are heuristic, not solved** | They exist to teach against recognisable styles, not to be strong; labelled as such in the UI | Not a goal — a solver would make the teaching worse, not better |
| G7 | **The ICM model is Malmuth–Harville**, an approximation that ignores skill, position and blind pressure | It is the standard teaching model and its assumptions are stated | Nothing; the limitation is the teaching point |
| G8 | **Risk-of-ruin uses a diffusion approximation** assuming a constant edge, constant stakes and an infinite horizon | Stated with the figure, every time | Nothing; a real bankroll faces stake changes and non-normal tails, which is said out loud |
| G9 | **No rate limiting on WebSocket reconnection storms** beyond the per-session socket cap | Low impact for the current scale | A backoff requirement enforced server-side |
| G10 | ~~**Container base images may not be digest-pinned**~~ **Closed 2026-08-19.** Every base image and every GitHub Action is now pinned, and `ci-pinning` fails the release otherwise. Kept in the table, struck through, because a gap that vanishes without a trace teaches nobody anything | — | — |
| G11 | **A pinned digest is not a vouched-for digest** | Pinning buys immutability: an upstream cannot change what runs here without a diff in this repository. It does not say the artefact was benign when the digest was taken | Verifying the base image and each action against upstream attestation at pin time, and recording the evidence — the release audit did this by hand once |
| G12 | ~~**Nothing re-checks a pin against new advisories**~~ **Mostly closed — 2026-08-26 and 2026-08-27.** The OSV gate does query the `npm` ecosystem only, but two other gates cover the pins it does not. `container-scan` reads the Alpine package database inside the built images and caught CVE-2026-14456 (HIGH, OpenSSL) in the `node:24.18.0-alpine3.24` digest hours after it was built. `action-advisories` resolves each of the 63 pinned action SHAs to its version via `git ls-remote --tags` — not via the trailing comment, which it verifies rather than trusts — and matches it against OSV's `GitHub Actions` corpus, failing rather than passing when the corpus is unreachable, arrives short, or the SHA is a commit no tag names. Both run inside `security:audit`. Until 2026-10-11 `.github/workflows/supply-chain.yml` ran that daily against the unchanged repository; the owner removed it, so between pushes an advisory against an untouched pin reaches the repository only through Dependabot (`.github/dependabot.yml`) — which covers npm and GitHub Actions pins but not `container-scan`'s image packages. Struck through rather than deleted, because the reasoning that left it open ("pinning is the answer") is the part worth keeping visible | What remains: an advisory against a base image's upstream project that is not carried by a distro package still reaches nobody automatically |

## 10. Review triggers

Re-review this document when any of the following happens:

* `redactFor` or `commitment.ts` changes at all.
* A dependency is added, or the supply-chain policy is relaxed.
* Public matchmaking, chat, or any social feature beyond invite-only rooms is proposed.
* Anything resembling a purchase, transfer, prize or external redemption is proposed —
  which would invalidate the severity ratings throughout §5 and require a full redo.
* A new advisory affects the dependency set.
