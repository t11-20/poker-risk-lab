# Agent C — Security & Supply Chain — independent release review

**Reviewer:** Agent C (independent; did not write this code)
**Date:** 2026-08-18
**Repository:** `/Users/terence/Projects/exploration-sites/poker-risk-lab`
**Environment:** Node 24.18.0, pnpm 11.10.0, PostgreSQL 16 in Docker (migrated + seeded),
API live on `127.0.0.1:3001`, web live on `127.0.0.1:3000`.

**Verdict: FAIL** — one P1 blocks the documented release gate and both CI workflows.
No P0. The single most important security property in the brief — hidden cards and deck
order never leak — **holds under direct adversarial testing**, including the fold-ended
hand and hand review that were called out as the risky cases.

---

## Summary

| Severity | Count | Items |
| --- | --- | --- |
| **P0** | **0** | I looked hard, specifically at the hidden-information boundary. See "P0: nothing found" below for exactly what I tested. |
| **P1** | 1 | `pnpm run security:audit` — the documented release gate, and the gate both CI workflows run — fails with exit 1 and declares itself release-blocking. |
| **P2** | 3 | Log-redaction gap at the real secret field names; router-level errors bypass the error envelope and reflect the request URL; impersonation guard incomplete in the same class as the defect it was patched for. |
| **P3** | 3 | No dedicated rate limit on invite-code join; stale threat-model gap G10; SBOM gitignored. |

### What I verified as genuinely correct

Not "read and believed" — executed and inspected:

* **Hidden information.** Built two real two-player hands over the live API and WebSocket
  (fold-ended and showdown), captured every frame both players received plus both hand
  reviews, and walked every document structurally (cards are integers `0..51` here, so a
  text scan would have been unsound). Zero leaks. Showdown revealed exactly 9 positions
  (4 hole + 5 board), `reveal.complete = false`, no undealt card.
* **Authorization.** A third user is refused the room over REST (404, not 403), over
  WebSocket (close `4403`), and refused the hand review (404).
* **CSRF.** All 13 mutating routes reject a request with no `x-csrf-token`.
* **WebSocket.** `Origin` checked on upgrade (`4406`); auth from the cookie, not a frame
  (`4401`); socket cap 4 (`4429`); oversized frame (`1009`); flood (`4429`); handshake
  timeout (`4408`); every inbound frame schema-validated before routing.
* **Sessions.** Only `sha256(token)` stored; constant-time comparison surviving length
  mismatch; logout revokes and a replayed cookie is dead; re-auth rotates the token and
  kills the previous session; every tampered cookie refused and cleared.
* **OIDC.** Every adversarial `redirectAfter` neutralised; `alg: none` and all symmetric
  algs refused; exact `iss` match; `state`/`nonce`/PKCE-verifier stored as sha256 only and
  consumed by a single atomic `UPDATE ... WHERE consumed_at IS NULL ... RETURNING`.
* **Input validation.** Closed and bounded schemas, semantic cross-checks, prototype
  pollution rejected, 2 MB body → 413.
* **Injection.** No `.unsafe()` outside the migration runner; no `dangerouslySetInnerHTML`;
  no `Math.random` in production code.
* **Supply chain.** 162 lockfile versions; zero denied packages; zero non-registry
  resolutions; zero version ranges; 10/10 sampled integrity hashes match the registry and
  one tarball recomputed from downloaded bytes; SBOM is valid CycloneDX 1.6 and matches the
  lockfile exactly; policy genuinely live in pnpm's effective config; CI fully SHA-pinned,
  `contents: read`, frozen install, no secrets.
* **Containers.** Non-root, all three images digest-pinned, `read_only` + explicit tmpfs,
  `cap_drop`, `no-new-privileges`, HEALTHCHECK, `.env` excluded from the build context.
* **Database.** `pnpm run db:verify` → 121 columns, 41 indexes, 13 tables checked, "every
  documented schema security property holds".
* **Smoke.** `pnpm run test:smoke` → 37/37 passed.

---

## P0: nothing found

An empty P0 list is only worth anything if you know what was actually attempted. On the
hidden-information boundary specifically, I:

1. Read `packages/poker-engine/src/redact.ts` and confirmed `redactFor` **constructs**
   `PlayerView` rather than deleting fields from `HandState` — a fail-closed design.
2. Grepped every route and every WebSocket send for what it emits. The only exit is
   `table.viewFor(userId)` → `redactFor(state, { viewerSeat })`. No route or frame carries a
   raw `HandState`. `WsRouter.broadcastExcept` calls `viewFor` **per recipient**; there is no
   build-once-send-to-all path.
3. Built a real fold-ended hand and structurally walked all 10 frames A received, all 19
   frames B received, and both hand-review responses, checking every numeric value at every
   path against the set of cards that recipient was not entitled to see.
4. Built a real showdown hand and checked the Merkle reveal contained no position beyond
   board + shown hole cards.
5. Confirmed the deck secret dies with the hand: there is no column for it, and
   `HandResult.reveal` carries proofs only for positions that legitimately became public.

Evidence, from the fold-ended hand (`scratchpad/deepscan.mjs`):

```
A own = [18,50] (6h Ah)
B own = [11,36] (4s Jc)

[A frames vs B cards] documents=10  forbidden=4s,Jc
  NO LEAK: none of the forbidden card values appear at any path
[B frames vs A cards] documents=19  forbidden=6h,Ah
  NO LEAK: none of the forbidden card values appear at any path
[A review vs B cards] documents=1  forbidden=4s,Jc
  NO LEAK: none of the forbidden card values appear at any path
[B review vs A cards] documents=1  forbidden=6h,Ah
  NO LEAK: none of the forbidden card values appear at any path

=== secret-shaped KEYS anywhere in any document ===
  A frames: none    B frames: none    A review: none    B review: none

reveal = {"commitment":{"algorithm":"sha256","version":"prl-deck-v2",
  "root":"ca3485f0…","context":"room_…:1:hand_…"},"cards":[],"complete":false}
```

The fold case is exactly right: `cards: []`, so nobody learns whether the folder was
bluffing. And from the showdown hand:

```
board Kh Ah 8c Ac Ts
reveal.complete = false  reveal.cards count = 9
revealed=9 publicCards=9 EXTRA (undealt/unentitled leaked)=[]
revealed cards: 3s 8h 4c 2s Kh Ah 8c Ac Ts
review A verification = {"ok":true,"verifiedPositions":9}
```

I could not construct a hidden-card leak.

---

## P1-1 — `pnpm run security:audit` fails: the release gate and both CI workflows are red

**Severity:** P1
**Location:** `scripts/supply-chain/policy-check.mjs:92-106` (the `execFileSync('pnpm', ['config','list','--json'])` call), asserted at `:58-62`. Consumed by `package.json` → `"security:audit"`, and by `.github/workflows/ci.yml:118` and `.github/workflows/supply-chain.yml:95`.

### Problem

The policy gate asks pnpm for its *effective* configuration by shelling out to
`pnpm config list --json`. But when the gate itself is launched through `pnpm run`, pnpm
injects `pnpm_config_verify_deps_before_run=false` into the child environment (its own
mechanism for not re-verifying deps in a nested invocation). The nested `pnpm config list`
inherits that variable and reports `false`. The gate asserts `'error' || true`, fails, and
the audit exits 1 printing "1 gate(s) failed — this is release-blocking."

The underlying policy is **fine**. `pnpm-workspace.yaml:38` really does say
`verifyDepsBeforeRun: error`, and read outside a `pnpm run` child, pnpm reports it
correctly. This is a false failure in the gate, not a supply-chain hole — but it means the
release gate has never been green through its documented entry point, and CI cannot pass.

### Reproduction

```
$ cd /Users/terence/Projects/exploration-sites/poker-risk-lab

$ pnpm run security:audit
  ...
  ✗ policy setting not in effect: verifyDepsBeforeRun = false
      required because: refuse to run against a stale node_modules
      set it in pnpm-workspace.yaml (NOT .npmrc — pnpm 11 ignores policy keys there)
  ✗ policy-in-effect — 1 failure(s)
Summary
  ✗ FAIL  policy in effect
  ✓ pass  source encoding hygiene
  ✓ pass  denied packages
  ✓ pass  dependency shapes
  ✓ pass  Shai-Hulud IOC sweep
  ✓ pass  integrity + release age
  ✓ pass  OSV vulnerabilities
  ✓ pass  SBOM generation
1 gate(s) failed — this is release-blocking.
[ELIFECYCLE] Command failed with exit code 1.
```

Same code, same lockfile, same machine, invoked directly instead:

```
$ node scripts/supply-chain/audit.mjs
Summary
  ✓ pass  policy in effect
  ✓ pass  source encoding hygiene
  ✓ pass  denied packages
  ✓ pass  dependency shapes
  ✓ pass  Shai-Hulud IOC sweep
  ✓ pass  integrity + release age
  ✓ pass  OSV vulnerabilities
  ✓ pass  SBOM generation
All supply-chain gates passed.
DIRECT_EXIT=0
```

### Evidence

The injected variable, and the divergence it causes:

```
$ pnpm exec env | grep -i verify_deps
pnpm_config_verify_deps_before_run=false

$ pnpm config get verifyDepsBeforeRun      # read from a normal shell
error

$ pnpm run security:policy                  # read from inside a `pnpm run` child
  ✗ policy setting not in effect: verifyDepsBeforeRun = false

$ node scripts/supply-chain/policy-check.mjs
  ✓ policy-in-effect — pass
```

The policy file that the gate is failing to see (`pnpm-workspace.yaml:38`):

```yaml
verifyDepsBeforeRun: error
```

I also checked the gate is not compromised in the *dangerous* direction — it still catches
a genuinely unsafe config forced through the environment, so the fix must not simply delete
the assertion:

```
$ pnpm_config_ignore_scripts=false pnpm_config_minimum_release_age=0 \
  pnpm_config_verify_store_integrity=false node scripts/supply-chain/policy-check.mjs
  ✗ policy setting not in effect: ignoreScripts = false
  ✗ policy setting not in effect: minimumReleaseAge = 0
  ✗ policy setting not in effect: verifyStoreIntegrity = false
```

(`npm_config_`-prefixed variables do **not** override the workspace file — only pnpm's own
`pnpm_config_` injection does. That is why this manifests for exactly one setting.)

### Fix

Read the setting from a context pnpm has not overridden for its own bookkeeping. Options, in
order of preference:

1. In `policy-check.mjs`, delete the inherited override before spawning: pass an `env` to
   `execFileSync` with `pnpm_config_verify_deps_before_run` (and, defensively, any
   `pnpm_config_*` / `npm_config_*` key matching a `REQUIRED` name) removed. That keeps the
   "ask pnpm for the effective value" design, which is the whole point of the gate.
2. Or assert `verifyDepsBeforeRun` against the parsed `pnpm-workspace.yaml` specifically,
   with a comment saying why this one setting cannot be read from the effective config, and
   keep the other 11 on the effective-config path.

Do **not** relax the assertion to accept `false`, and do not drop the key — the setting is a
real protection and the gate's job is to notice if it goes missing.

### Missing test

A test that runs the policy gate **through `pnpm run`** and asserts exit 0 — i.e. asserts the
gate is correct through its documented entry point, not only when called directly. Today
every check of this gate invokes it the way that happens to work. Concretely:
`assert.equal(spawnSync('pnpm', ['run', 'security:policy']).status, 0)`. A companion test
should assert the gate still fails when a required setting is genuinely wrong, so the fix
cannot be "stop asserting".

---

## P2-1 — Log redaction misses the actual secret field names on `HandState`

**Severity:** P2 (defence-in-depth; not reachable today)
**Location:** `apps/api/src/logging.ts:74-84` (`EXPLICIT_SENSITIVE_KEYS`) and `:63-64` (`SENSITIVE_KEY_PATTERN`); `REDACT_PATHS` at `:336`.

### Problem

The comment above `EXPLICIT_SENSITIVE_KEYS` states its purpose plainly: *"The rest is hidden
game state that the server authority rules say never leaves this process … A log line is an
exit this project has to close explicitly."* The set contains `deck`, `salt`, `salts`,
`deckorder`, `commitmentsalt`, `holecards`.

It does **not** contain the field names those secrets actually have on `HandState`
(`packages/poker-engine/src/types.ts:200-236`): `deckSalts`, `deckCursor`,
`holeCardPositions`, `boardPositions`. Neither does `SENSITIVE_KEY_PATTERN` match them.
So the scrubber passes the 52 Merkle salts through **in full**.

This is precisely the failure mode the file's own comment warns about for `REDACT_PATHS`:
"the classic way a redact list looks complete and is not." Because `deck`, `salt` and
`salts` *are* covered, the list reads as complete.

Also uncovered: `codeVerifier`, `state`, `nonce` — the OIDC single-use credentials.

### Reproduction

```
$ node scratchpad/redact-test.mjs
=== isSensitiveKey against the ACTUAL secret field names on HandState ===
  censored     deck
  *** NOT CENSORED *** deckCursor
  *** NOT CENSORED *** deckSalts
  *** NOT CENSORED *** commitment
  censored     holeCards
  *** NOT CENSORED *** holeCardPositions
  *** NOT CENSORED *** boardPositions

  censored     salt          censored     salts        censored     commitmentSalt
  not censored codeVerifier  not censored state        not censored nonce
```

Feeding a `HandState`-shaped object through the real exported scrubber:

```
$ node scratchpad/redact-test.mjs   # scrubLogObject section
scrubbed = {"handId":"hand_x","deck":"[redacted]","deckCursor":9,
  "deckSalts":{"type":"Buffer","data":[222,173,190,239,222,173,190,239,222,173,190,239,
  222,173,190,239,222,173,190,239,222,173,190,239,222,173,190,239,222,173,190,239]},
  "holeCardPositions":{"0":[0,1],"1":[2,3]},"boardPositions":[4,5,6],
  "seats":[{"seat":0,"holeCards":"[redacted]","stack":200}],
  "commitment":{"root":"abc","context":"ctx","salts":"[redacted]"}}
```

`deck`, `holeCards` and `commitment.salts` are redacted. `deckSalts` is emitted as raw bytes.

### Evidence that it is not reachable today

I enumerated all 28 log call sites (`grep -rn "log\.\(info\|warn\|error\|debug\|trace\|fatal\)("`).
None passes a `HandState` or a salt. Two spread an arbitrary object —
`apps/api/src/routes/index.ts:91` and `apps/api/src/ws/hub.ts:197`, both
`app.log.warn({ ...detail }, message)` — which is the mechanism by which such a key would
arrive if a future caller passed one. That is exactly the case the scrubber exists to catch.

### Fix

Add `deckcursor`, `decksalts`, `holecardpositions`, `boardpositions`, `codeverifier`,
`oidcstate`, `oidcnonce` to `EXPLICIT_SENSITIVE_KEYS`. Better: derive the game-state half of
the list from the engine rather than restating it, so a new secret field on `HandState`
cannot be added without the redaction list following — e.g. export the secret key names from
`poker-engine` beside the `HandState` declaration and import them here. That converts this
from "remember to update two files" to fail-closed.

### Missing test

A test that asserts `isSensitiveKey` returns true for **every** field name the engine
declares secret, sourced from the engine rather than hard-coded in the test. Today
`logging` tests assert on names the author already thought of, which is the same blind spot
as the list itself. Add a second test that pushes a real `HandState` through
`scrubLogObject` and asserts no 32-byte buffer and no card array survives.

---

## P2-2 — Router-level errors bypass the error envelope and reflect the request URL

**Severity:** P2
**Location:** `apps/api/src/errors.ts:222-229` (`FASTIFY_CODE` map — note the `FST_ERR_BAD_URL` entry at `:228`) and `:419` (`app.setErrorHandler`). No `frameworkErrors` option is set in `apps/api/src/plugins/security.ts:468-498` (`securityServerOptions`).

### Problem

Two reachable paths return Fastify's raw internal error shape instead of the project's
`ApiError` envelope: the internal error `code`, the internal `message`, **the caller's URL
reflected back**, and no `requestId`.

This violates the project's own stated rule, `docs/SECURITY.md` §3 "Output":

> Never return an internal error message, stack trace or SQL fragment. Log the detail
> server-side, return `internal_error` with a request id.

It also makes the `FST_ERR_BAD_URL: 'invalid_request'` entry at `errors.ts:228` **dead
code** — it looks like the case is handled and it is not. Router errors in Fastify 5 are
raised before a route context exists and are served by `frameworkErrors`, not by
`setErrorHandler`, and `frameworkErrors` is not configured.

Impact is bounded — the response is `application/json`, so this is not an XSS vector, and a
64-character-plus path is not a secret. But a client parsing `body.error.code` gets the
string `"Bad Request"`, `body.error.message` is `undefined`, and there is no request id to
quote in a bug report. And the codebase goes to real lengths elsewhere to never reflect
caller-influenced text (`withoutControlCharacters`, `logging.ts:106`; "Only the contract's
own wording, never an internal message", `ws/router.ts:540`), so this is inconsistent with
its own standard.

### Reproduction

```
$ curl -s -H "origin: http://localhost:3000" \
    "http://127.0.0.1:3001/api/v1/hands/$(python3 -c 'print("a"*80)')"
{"error":"Bad Request","code":"FST_ERR_MAX_PARAM_LENGTH","message":"'/api/v1/hands/aaaaaaaa
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' is exceeding
the max param length","statusCode":414}

$ curl -s -H "origin: http://localhost:3000" "http://127.0.0.1:3001/api/v1/hands/%zz"
{"error":"Bad Request","code":"FST_ERR_BAD_URL","message":"'/api/v1/hands/%zz' is not a
valid url component","statusCode":400}
```

Contrast with every other error path, which is correctly enveloped:

```
$ curl -s -H "origin: http://localhost:3000" "http://127.0.0.1:3001/api/v1/hands/x'%20or%201=1--"
{"error":{"code":"invalid_request","message":"That request was not in a shape we understand.",
"requestId":"cbd…"}}
```

### Evidence

```
$ grep -rn "frameworkErrors" apps/api/src
(no output — the option is never set)

$ grep -n "FST_ERR_BAD_URL" apps/api/src/errors.ts
228:  FST_ERR_BAD_URL: 'invalid_request',
```

The map entry exists; the mechanism that would apply it does not.

### Fix

Set `frameworkErrors` in `securityServerOptions` (`plugins/security.ts`) to route
router-level errors through the same `apiErrorBody` builder the rest of the API uses,
mapping `FST_ERR_MAX_PARAM_LENGTH` → `invalid_request` (or a 414-appropriate code) and
`FST_ERR_BAD_URL` → `invalid_request`, and never echoing `error.message`. Add
`FST_ERR_MAX_PARAM_LENGTH` to `FASTIFY_CODE` while there.

### Missing test

A test that asserts **every** reachable error response matches the `ApiError` schema —
driven by a list of malformed requests including an over-long path parameter and an invalid
percent-escape — rather than testing only the errors that flow through `setErrorHandler`.
The current suite's error tests all go through the route layer, which is why both of these
were missed.

---

## P2-3 — The impersonation guard is bypassable by case and by near-synonym (fix for defect #8 is incomplete)

**Severity:** P2 (not attacker-reachable — it guards first-party generated text)
**Location:** `packages/poker-ai/src/labelling.ts:207-210` (the named-person mental-state pattern) and `:216-220` (the gendered-pronoun pattern).

### Problem

Defect #8 was reported as the guard missing `"Ivey senses weakness"` (a name before a
mental-state verb) and `"He would raise here"` (a poker verb after `would`). Both specific
strings are now caught. But the patch left the same class of gap open in four ways.

The named-person pattern is:

```js
/\b\p{Lu}\p{L}+\s+(?:thinks?|feels?|believes?|senses?|intends?|wants?|remembers?)\b/u
```

There is no `i` flag (necessarily, since `\p{Lu}` requires an uppercase initial). The
consequence is that the *verb* is also matched case-sensitively, so the very sentence the
patch was written for slips through when capitalised differently. And the verb list omits
`knows` and `suspects`. The `would` + poker-verb case is covered only via the gendered
pronoun rule, so the same construction with a **name** instead of a pronoun is uncaught.

### Reproduction

```
$ node scratchpad/imp-test.mjs
=== findImpersonation ===
  FLAGGED  "Ivey senses weakness"        [{"why":"attributes a mental state to a named person"}]
  FLAGGED  "He would raise here"         [{"why":"uses a gendered pronoun…"}]
  allowed  "IVEY SENSES WEAKNESS"
  allowed  "ivey  senses   weakness"
  allowed  "Negreanu knows you are bluffing"
  allowed  "Brunson suspects a bluff"
  allowed  "Daniel would never call this"
```

The guard flags `"Ivey senses weakness"` and allows the identical sentence uppercased. That
single pair is the finding.

### Evidence

The guard does run in production (not only in tests) — `assertNoImpersonation` is called at
generation time from `policy.ts:1538-1543`, `commentary.ts:345`, `profiles.ts:729`,
`opponent-model.ts:720,738,1016,1095` and `stats.ts:675,748,759`. So it is a live gate over
generated strings, which is why its completeness matters. It is **not** applied to user
input (display names and room names are constrained by schema patterns instead), so this is
not an attacker vector — it is a gate that would fail to catch an author's or generator's
mistake.

The `knows` exclusion is documented at `labelling.ts:201-206` as necessary because the
policy legitimately emits `"Opponent read:"`. That justifies excluding `reads`; it does not
justify excluding `knows`, which is a different word.

### Fix

* Normalise before matching: case-fold for the verb and collapse runs of whitespace, while
  keeping the uppercase-initial requirement on the name (match the name with an explicit
  `\p{Lu}` test on the captured token rather than relying on a case-sensitive whole regex).
* Add `knows`, `suspects`, `assumes`, `reckons`, `decides` to the verb list, and re-run the
  package's own 4,955-string corpus to confirm the false-positive count is still zero. If
  `knows` genuinely collides, exclude it by an anchored exception for `"Opponent read"`
  rather than by dropping the verb.
* Add a `NAME + would + <verb>` pattern so the name form of the `"He would raise here"` case
  is covered, not only the pronoun form.

### Missing test

The existing test (`packages/poker-ai/test/commentary.test.ts:342-355`) asserts the guard
rejects a fixed list of shapes. It should be a **mutation** test: for each string the guard
is known to reject, assert it is still rejected after case-folding, upper-casing and
whitespace expansion. That is the test that would have caught this patch being incomplete,
and it generalises to future patterns.

---

## P3-1 — No dedicated rate limit on `POST /rooms/join` (invite-code guessing)

**Severity:** P3
**Location:** `apps/api/src/routes/rooms.ts:278-286` — the route is registered with a body schema and no `config`, so it inherits only the global limiter (`plugins/security.ts:630-639`, `RATE_LIMIT_MAX=300` per 60 s).

### Problem

`docs/THREAT-MODEL.md` §T8 names "Room enumeration and uninvited joining" as a tracked
threat. The auth routes get `clientKeyedRateLimit` and the calculation routes get
`app.expensiveRateLimit`, but the one route that accepts a guessable secret gets neither.

The practical risk is very low, and I want to be honest about that rather than inflate it:
invite codes are 16 characters from a 31-symbol alphabet
(`apps/api/src/repositories/ids.ts:85-93`), which is ~79 bits. At 300 attempts a minute a
brute force is not a threat in any timeframe. The finding is about defence consistency and
about the global bucket being shared: 300/min of join attempts also consumes the caller's
budget for everything else, and a dedicated smaller bucket is both stricter and cheaper.

### Reproduction

```
$ grep -n -A3 "'/rooms/join'" apps/api/src/routes/rooms.ts
279:      '/rooms/join',
280:      { schema: { body: { $ref: 'prl:joinRoomBody#' } } },
```

No `config:` key, so no route-level limit. Compare `routes/auth.ts:384`
(`{ config: guestRateLimit, … }`) and `routes/calc.ts:132`
(`{ config: app.expensiveRateLimit, … }`).

### Evidence

Rate limiting is demonstrably working where it is applied — guest creation returned 429
after repeated attempts in my hostile-input run, and `/math/equity` returned 429 after ~20
requests, matching `RATE_LIMIT_EXPENSIVE_MAX=20`. So the absence on `/rooms/join` is an
omission, not a broken limiter.

### Fix

Apply `clientKeyedRateLimit(config, 20, 60_000)` to `POST /rooms/join`. Address-keyed rather
than session-keyed, for the same reason `routes/auth.ts:89` gives: a code-guessing client can
discard its cookie freely.

### Missing test

An integration test that sends N+1 wrong invite codes and asserts a 429 — the same shape as
the existing guest-creation rate-limit check in `scripts/smoke-test.mjs` §10, which is what
caught the analogous hole (defect #7) in the first place.

---

## P3-2 — `THREAT-MODEL.md` G10 and `SECURITY.md` §6 claim a container gap that does not exist

**Severity:** P3
**Location:** `docs/THREAT-MODEL.md` §9 row G10; `docs/SECURITY.md` §6 final bullet.

### Problem

Both documents state that base images "may not be digest-pinned … marked `TODO` rather than
filled with a fabricated digest". Every image in the repository **is** digest-pinned, and
there is no `TODO`. A threat model that lists an accepted gap which has since been closed
costs credibility on the gaps that are real.

### Reproduction

```
$ grep -n "image:" docker-compose.yml
68:    image: postgres:16-bookworm@sha256:60f4761b9035e0b8d5218f701a8c3382f641bf12b1604822574cf5be3baeb537

$ grep -n "^FROM" Dockerfile.api Dockerfile.web
Dockerfile.api:107:FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base
Dockerfile.web:58:FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base

$ grep -n "TODO" Dockerfile.api Dockerfile.web docker-compose.yml
(no output)
```

### Fix

Delete G10 from `THREAT-MODEL.md` §9 and the matching bullet from `SECURITY.md` §6, or
rewrite them as a **control** ("all base images are digest-pinned; see …") with a review
trigger for when a digest is refreshed.

### Missing test

A repo-hygiene check that fails if any `FROM` or compose `image:` lacks an `@sha256:` digest.
That makes the claim enforced rather than narrated, and means the doc cannot drift again.

---

## P3-3 — The SBOM is gitignored, so the required deliverable is not in the repository

**Severity:** P3
**Location:** `.gitignore` — `docs/sbom/*.json` with `!docs/sbom/.gitkeep`.

### Problem

An SBOM is a named deliverable. It is generated correctly and is valid, but it is excluded
from version control, so a consumer cloning the repo gets an empty `docs/sbom/`. It exists
only as a CI artifact (`ci.yml:126`, `ci.yml:400`, `supply-chain.yml:99`).

This also contradicts `docs/SECURITY.md` §4, which advertises the SBOM's byte-stability as a
version-control benefit: *"The SBOM is content-derived and byte-stable, so `git diff` shows
dependency changes rather than a fresh timestamp."* There can be no `git diff` on an ignored
file.

### Reproduction

```
$ grep -n "sbom" .gitignore
docs/sbom/*.json
!docs/sbom/.gitkeep
```

### Evidence

The generated SBOM is valid and complete, which is what makes ignoring it the only issue:

```
$ node scratchpad/integrity.mjs   # SBOM section
  bomFormat=CycloneDX specVersion=1.6 serialNumber=urn:uuid:b2c65c45-a51c-4399-88…
  components=170 dependencies=171
  missing: none
  components missing name/version/type/bom-ref: 0
  components without purl: 0
  lockfile versions=162 sbom npm components=170
  in lockfile but NOT sbom (0):
  in sbom but NOT lockfile (8): @prl/api@0.1.0, @prl/web@0.1.0, … (the workspace packages)
```

### Fix

Commit `docs/sbom/poker-risk-lab.cdx.json` (it is byte-stable by design, so it will not churn),
and keep `osv-report.json` / `provenance-report.json` ignored if those are genuinely
run-dependent. Or, if the SBOM is meant to be build-only, correct §4 of `SECURITY.md` so it
stops promising a `git diff` that cannot happen.

### Missing test

A hygiene check asserting that `docs/sbom/poker-risk-lab.cdx.json` is tracked and that
regenerating it produces no diff — which simultaneously proves the byte-stability claim.

---

## Detailed verification log

### 1. Hidden-card leakage

Covered above under "P0: nothing found". Scripts:
`scratchpad/leakhunt.mjs`, `scratchpad/showdown.mjs`, `scratchpad/deepscan.mjs`.

One methodological note worth recording: my first scan was **unsound**. Cards cross the wire
as integers (`[18,50]`), and I initially scanned the serialised text for `"18"`, which cannot
match the unquoted `18` in JSON. I rewrote the scan to walk parsed objects and compare
numeric values at every path, classifying hits by whether the path is card-shaped. Anyone
re-running this should use the structural version.

### 2. Auth / session

| Property | Result |
| --- | --- |
| Cookie attributes (dev) | `prl_session=…; Max-Age=1209599; Path=/; HttpOnly; SameSite=Lax` — no `Secure`/`__Host-`, correct for dev; both are gated on `config.isProduction` (`plugins/security.ts:139-145`, `:168-176`) and a production boot with `COOKIE_SECURE=false` is refused (`config.ts:475-480`) |
| Signed | Yes, HMAC-SHA256, stated explicitly rather than defaulted (`plugins/security.ts:576`) |
| Only a hash stored | Yes — `token_hash prl.sha256_hash NOT NULL`; `create` writes `hashToken(token)` (`repositories/sessions.ts:126-136`) |
| Constant-time comparison | `timingSafeEquals` (`repositories/hashing.ts:181-184`) returns `timingSafeEqual(a, right) && sameLength`, comparing against `a` itself on a length mismatch so it cannot throw |
| Revocation | Verified live: after logout the replayed cookie yields `user: null` and `/me/progress` → 401 `session_expired` |
| Fixation | Verified live: re-auth rotates the token and the previous session is dead |
| Sliding expiry with a ceiling | `SESSION_IDLE_TTL_MS` slides past halfway, capped at `created_at + 60 days` (`auth/session.ts:66-83`, `:193-195`) |
| Tampered cookies | All 6 variants refused **and** the cookie cleared |

### 3. OIDC

Every check in the brief is present and behaves correctly under adversarial input
(`scratchpad/oidc-test.mjs`). Highlights:

```
=== isSafeRedirectPath / safeRedirectTarget (origin https://app.example.com) ===
  ok  safe=false  in="https://evil.com"      -> https://app.example.com/
  ok  safe=false  in="//evil.com"            -> https://app.example.com/
  ok  safe=false  in="/\\evil.com"           -> https://app.example.com/
  ok  safe=false  in="/%2f%2fevil.com"       -> https://app.example.com/
  ok  safe=false  in="/\r\nSet-Cookie:a=b"   -> https://app.example.com/
  ok  safe=true   in="/lessons?x=1&y=2"      -> https://app.example.com/lessons?x=1&y=2
```

All 30 adversarial values I tried stayed on the trusted origin; none escaped.

```
=== assertAlgAllowed (provider advertises RS256,ES256) ===
  alg="none"  refused (unsigned tokens are refused)
  alg="None"  refused        alg="NONE"  refused        alg="nOnE"  refused
  alg="HS256" refused (symmetric; refused to avoid algorithm confusion)
  alg="hs256" refused        alg="Hs384" refused
  alg="RS256" ACCEPTED       alg="ES256" ACCEPTED
  alg="RS512" refused        alg="rs256" refused        alg="PS256" refused
=== alg the provider does NOT advertise ===
  alg=RS256 providerAlgs=["ES256"] refused (not one the provider advertises)
```

Exact `iss` match, including rejecting a trailing-slash variant:

```
  doc.issuer=https://evil.example  expected=https://good.example -> refused
  doc.issuer=https://good.example/ expected=https://good.example -> refused
```

State/nonce/verifier are three independent 43-character CSPRNG values (`state===nonce? false`),
the PKCE challenge verifies, and storage is digest-only:

```
$ grep -n "state_hash\|nonce_hash\|pkce_verifier_hash" db/migrations/0001_initial.sql
331:  state_hash          prl.sha256_hash NOT NULL,
332:  nonce_hash          prl.sha256_hash NOT NULL,
333:  pkce_verifier_hash  prl.sha256_hash NOT NULL,
```

Consumption is atomic — a single statement, not check-then-update
(`repositories/sessions.ts:471-480`):

```sql
update prl.oidc_login_attempts
   set consumed_at = now()
 where state_hash = … and consumed_at is null …
returning …
```

with `oidc_login_attempts_state_hash_key` unique across consumed rows too
(`0002_indexes_and_constraints.sql:85-86`), so a replayed state cannot create a second
attempt. The callback compares the cookie's state to the query's with `timingSafeEquals` over
digests, then consumes the **cookie's** value (`routes/auth.ts:325-331`).

### 4. CSRF

All 13 mutating routes reject a request with no token. I could not find one that is not
covered:

```
CSRF-BLOCKED POST /auth/guest              CSRF-BLOCKED POST /auth/logout
CSRF-BLOCKED POST /me/units/reset          CSRF-BLOCKED POST /rooms
CSRF-BLOCKED POST /rooms/join              CSRF-BLOCKED POST /rooms/:id/sit
CSRF-BLOCKED POST /rooms/:id/stand         CSRF-BLOCKED POST /equity
CSRF-BLOCKED POST /coach                   CSRF-BLOCKED POST /content/lessons/:id/quiz
CSRF-BLOCKED POST /content/scenarios/:id/attempt
CSRF-BLOCKED POST /legends/match           CSRF-BLOCKED POST /legends/compare

routes NOT csrf-blocked: none
```

### 5. WebSocket

```
hostile origin https://evil.test       -> opened=true CLOSED 4406 "origin not allowed"
NO origin header                       -> opened=true CLOSED 4406 "origin not allowed"
valid origin, NO cookie                -> opened=true CLOSED 4401 "no session"
origin suffix attack (…[U+200B].evil.test)     -> opened=true CLOSED 4406 "origin not allowed"
literal null origin                    -> opened=true CLOSED 4406 "origin not allowed"
empty origin                           -> opened=true CLOSED 4406 "origin not allowed"
127.0.0.1 origin (not allowlisted)     -> opened=true CLOSED 4406 "origin not allowed"
forged session cookie                  -> opened=true CLOSED 4401 "no session"
origin case variation (LOCALHOST)      -> accepted  (correct: scheme+host are case-insensitive)
VALID origin + cookie (control)        -> accepted

oversized frame (200 KB)  -> closed 1009
frame flood (400 frames)  -> closed 4429 "too many messages"
no hello                  -> closed 4408 "no hello"
malformed frames          -> 3× {"type":"error","error":{"code":"invalid_request",…}}, socket kept
maxSocketsPerSession      -> sockets 1–4 open; 5–8 closed 4429 "too many sockets"
```

**Methodology warning for anyone repeating this:** the hub accepts the upgrade and *then*
closes with a code (`ws/hub.ts:252-257`), so a probe that resolves on the `open` event
reports "opened, not refused" and looks like a wide-open server. My first run did exactly
that and produced six false alarms. The probe must wait for the `close` event.

Auth comes from the cookie during the upgrade, never from a frame — `hello` has no
credential field in the schema (`packages/contracts/src/schemas.ts:293-301`), and validation
runs before routing (`ws/router.ts:264-268`), cheapest-first: size → rate → parse → schema →
route.

### 6. Authorization

```
C GET  /rooms/:id        -> 404 room_not_found_or_not_permitted   (does not confirm existence)
C POST /rooms/:id/sit    -> 404 room_not_found_or_not_permitted
C GET  /rooms            -> 200 {"rooms":[]}
C WS   hello <A's room>  -> error room_not_found_or_not_permitted, close 4403 "not permitted"
C GET  /hands/<A's hand> -> 404 hand_not_found
X GET  /me/progress?userId=<Y>  -> 200 X's own progress (the parameter is ignored)
X GET  /hands?userId=<Y>        -> 400 invalid_request (closed querystring schema)
```

`registry.require` returns the same `room_not_found_or_not_permitted` for "no such room" and
"not your room" (`rooms/registry.ts:511-527`), so room ids cannot be confirmed by probing.

### 7. Injection

```
$ grep -rn "\.unsafe(" --include=*.ts --include=*.mjs . | grep -v node_modules
→ only apps/api/scripts/migrate.mjs (whole-file DDL, the sanctioned use) and prose/tests

$ grep -rn "dangerouslySetInnerHTML\|innerHTML\|eval(\|new Function" \
    --include=*.ts --include=*.tsx apps/web/src packages/ui/src
→ only two comments explaining why it is NOT used

$ grep -rn "Math\.random" --include=*.ts apps/*/src packages/*/src
→ zero occurrences in production code (only prose and the tests that assert its absence)
```

The one inline `<script>` (`apps/web/src/app/layout.tsx:105`) renders a module-level
constant (`THEME_BOOT_SCRIPT`) with no interpolation of request or user data.

### 8. Input validation

Closed (`additionalProperties: false`), bounded, and semantically checked
(`scratchpad/hostile3.mjs`):

```
200  BASELINE valid              ACCEPTED         trials=1000 eq=0.635
400  samples 1e12                invalid_request  {"samples":"must be <= 500000"}
400  samples 500001              invalid_request  {"samples":"must be <= 500000"}
400  samples 999                 invalid_request  {"samples":"must be >= 1000"}
400  samples 1e999 -> Infinity   invalid_request  {"samples":"must be integer"}
400  samples NaN literal         invalid_request  (body rejected)
400  samples 1000.5              invalid_request  {"samples":"must be integer"}
400  extra field                 invalid_request  {"evil":"is not a field this endpoint accepts"}
400  __proto__ key               invalid_request  (proto poisoning refused)
400  duplicate cards AhAh        invalid_request  {"heroCards":"heroCards contains the same card twice"}
400  hero card also on board     invalid_request  {"board":"the board repeats a card hero is holding…"}
400  6-card board                invalid_request  {"board":"a board has 0, 3, 4 or 5 cards…, this has 6"}
400  opponents 6 (max 5)         invalid_request  {"opponents":"must NOT have more than 5 items"}
400  opponents []                invalid_request  {"opponents":"must NOT have fewer than 1 items"}
400  range 200 chars             invalid_request  {"opponents.0":"must NOT have more than 120 characters"}

Object.prototype.admin after the __proto__ attempt: undefined
```

2 MB body → `413 payload_too_large`. Display names reject bidi overrides (`U+202E`), NUL,
zero-width space, leading/trailing space, over/under length, and emoji, via an allowlist
pattern rather than a denylist.

`onProtoPoisoning: 'error'` and `onConstructorPoisoning: 'error'` are stated explicitly even
though they are the Fastify 5 defaults (`plugins/security.ts:485-486`), and
`routerOptions.maxParamLength: 64` / `allowUnsafeRegex: false` are set.

### 9. Rate limits

| Route class | Limit | Verified |
| --- | --- | --- |
| Global | 300 / 60 s, ban after 200 over | Yes — 429s observed |
| `POST /auth/guest` | 10 / 60 s, **address-keyed** | Yes — 429 after repeats; smoke §10 also asserts it |
| OIDC start/callback | address-keyed | Code (`routes/auth.ts:381`) |
| `POST /math/equity`, `/math/coach`, hand review, `/legends/compare` | 20 / 60 s | Yes — 429 after ~20 |
| WS messages | token bucket + coach/min | Yes — 4429 |
| `POST /rooms/join` | **global only** | See P3-1 |

Defect #7's fix holds: session-minting routes key on the hashed address
(`plugins/security.ts:439-457`), so the counter cannot be reset by accepting the new cookie.

### 10. Logs and secrets

Redaction is three-layered (key-name pattern, explicit key set, pino `redact` paths) and the
call sites are careful — the OIDC provider error is stripped to `[^a-z_]` and truncated
before logging (`routes/auth.ts:488-491`), IPs are keyed HMACs not raw values
(`repositories/hashing.ts:144-153`), and no log call passes a card or a token. The gap is
P2-1 above.

Committed secrets: none. `.env` is gitignored; `.env.example` carries
`SESSION_COOKIE_SECRET=replace-me-this-example-value-is-rejected-in-production` and the real
`.env` value differs. `OIDC_CLIENT_SECRET` is commented out with "Do not commit it."

### 11. Containers

| Property | API | Web | Postgres |
| --- | --- | --- | --- |
| Base pinned by digest | `@sha256:6f7b03f7…` | same | `@sha256:60f4761b…` |
| Non-root | `USER node` | `USER node` | `read_only` + tmpfs |
| `read_only` root fs | yes | yes | yes |
| `cap_drop` / `no-new-privileges` | yes | yes | yes |
| HEALTHCHECK | yes | yes | compose healthcheck |
| `.env` in build context | no — `.dockerignore` excludes `.env`, `.env.*` | same | n/a |

### 12–18. Supply chain

Gate output: see P1-1 for both invocations. Independent checks (not using the project's own
scripts):

```
$ node scratchpad/depgraph.mjs
=== lockfile packages section: 162 entries ===
lockfileVersion: 9.0
=== DENIED packages in graph: NONE ===
=== non-registry resolutions: NONE ===
=== version RANGES in first-party manifests ===
  none — every third-party spec is an exact version
```

Checked against the full denylist: `keyv`, `cacheable`, `flat-cache`, `file-entry-cache`,
`cacheable-request`, `cache-manager`, `@cacheable/*`, `@antv/*` — none present.

Lifecycle scripts in the 77 installed manifests: **no** `preinstall`, `install` or
`postinstall` anywhere. Nine packages declare source-time hooks only, which registry
installs do not run, and `ignoreScripts: true` is live regardless:

```
ajv@8.20.0 :: prepublish            cookie@1.1.1 / 2.0.1 :: prepare
csstype@3.2.3 :: prepublish         fast-deep-equal@3.1.3 :: prepublish
ip-address@10.5.0 :: prepack, prepare = git config core.hooksPath hooks || true
pino-abstract-transport@3.0.0 :: prepare = husky install
postgres@3.4.9 :: prepare           ret@0.5.0 :: prepare
```

(`ip-address`'s `prepare` would rewrite the repo's git hooks path if it ever ran. It does
not, on two independent grounds. Worth knowing it is there.)

Policy genuinely in pnpm's effective config (item 14) — read outside a `pnpm run` child:

```
$ pnpm config list --json
ignoreScripts = true            minimumReleaseAge = 10080
minimumReleaseAgeExclude = []   verifyStoreIntegrity = true
verifyDepsBeforeRun = "error"   onlyBuiltDependencies = []
dangerouslyAllowAllBuilds = false   packageManagerStrict = true
saveExact = true                strictPeerDependencies = true
autoInstallPeers = false        engineStrict = true
registry = "https://registry.npmjs.org/"
```

`.npmrc` correctly carries **only** registry keys, so no policy setting is sitting somewhere
pnpm 11 would ignore.

Integrity cross-check against the registry (item 15) — 10 of 162 sampled, all match, and one
recomputed from the downloaded bytes:

```
MATCH fastify@5.11.3   MATCH postgres@3.4.9   MATCH @fastify/cookie@11.1.2
MATCH next@16.3.0      MATCH react@19.2.8     MATCH ws@8.21.3
MATCH typescript@7.0.2 MATCH @fastify/websocket@11.3.0
MATCH pino@10.3.1      MATCH @biomejs/biome@2.5.7
mismatches: 0

postgres@3.4.9 recomputed from 47571 downloaded bytes:
  sha512-GD3qdB0x1z9xgFI6cdRD6xu2Sp2WCOEoe3mtnyB5Ee0XrrL5Pe+e4CCnJrRMnL1zYtRDZmQQVbvOttLnKDLnaw==
  bytes match lockfile integrity? true
```

IOC sweep (item 16), run independently over the whole tree including `node_modules`:

```
reversed campaign string / t.m-kosche[.]com / webhook.site
  → only docs/security/shai-hulud-snapshot-2026-08-17.md and
    scripts/supply-chain/denied-packages.mjs (the project's own documentation and denylist)
artefact paths (.claude/setup.mjs, .vscode/setup.mjs, bun_environment.js,
  truffleSecrets.json, cloud.json, contents.json, environment.json) → none present
any file named setup.mjs anywhere → none
```

CI (item 17): all 19 `uses:` lines are full 40-character SHAs with the version in a trailing
comment (`19 total`, `19 pinned`); `permissions: contents: read` at the top level of both
workflows and never widened; `pnpm install --frozen-lockfile` in all 8 install steps;
`grep "secrets\." → no matches`.

SBOM (item 18): valid CycloneDX 1.6, 170 components, all with `name`/`version`/`type`/
`bom-ref`/`purl`, and an exact match to the lockfile — 0 lockfile entries missing, and the
only 8 extras are the first-party workspace packages, which correctly carry no registry
hashes. See P3-3 for the one issue (it is gitignored).

---

## Status of the eight previously-fixed defects

| # | Defect | Holds? |
| --- | --- | --- |
| 1 | `pnpm run` broken workspace-wide | Fixed — `pnpm run` works. **But** see P1-1: the policy gate now false-fails under `pnpm run` because of pnpm's `verify_deps_before_run` env injection. |
| 2 | Exhaustive suite in default `pnpm test` | Fixed — `test` = `test:unit && test:integration`; `test:exhaustive` is separate. |
| 3 | `.env.example` DB password wrong | Fixed — `.env.example:88-92` documents matching compose's `poker-dev-only` and explains the coupling. |
| 4 | Five sources disagreed on the API port | Fixed — 3001 consistently; the live web client reaches the API. |
| 5 | Session plugin in an encapsulated scope | Fixed — `skip-override` + idempotent registration (`auth/session.ts:367-411`); `GET /api/v1/hands` returned 200 in my run. |
| 6 | Room registry defaulted to a no-op archive | Fixed — hands persist; `GET /hands` returned a real completed hand after my fold-ended hand. |
| 7 | Guest rate limiting bypassable via key rotation | Fixed — address-keyed for session-minting routes; 429 observed live. |
| 8 | Impersonation guard missed two shapes | **Incomplete** — both reported strings are caught, but see P2-3 for four remaining bypasses in the same class, including the same sentence uppercased. |

---

## Could not verify

* **OIDC end-to-end against a real provider.** `oidcEnabled: false` in this environment (no
  `OIDC_*` configured), so I verified every check as a unit — signature algorithm selection,
  `iss`/`aud`/`exp`/`nbf`/`nonce`, discovery validation, redirect safety, atomic single-use
  consumption — but no full authorization-code round trip. The JWKS fetch/rotation path
  (`auth/oidc.ts:102-104`, unknown-`kid` refetch with a 30-second floor) is read-only
  reviewed.
* **Production cookie attributes in situ.** `__Host-` prefix and `Secure` are gated on
  `config.isProduction`, which is false here. I confirmed the code path and the boot-time
  refusal of `COOKIE_SECURE=false` in production (`config.ts:475-480`), but did not run a
  production build to observe the headers.
* **HSTS.** Correctly disabled in development; not observed live.
* **Container runtime behaviour.** I verified the Dockerfiles and compose file statically —
  non-root, digest pins, read-only root, dropped capabilities, healthchecks. I did not build
  or run the images, so I cannot confirm the API starts under `read_only` with only the
  declared tmpfs mounts.
* **`security:audit -- --offline`.** Documented in `SECURITY.md` §4; not exercised.
* **Rate-limiter behaviour under a shared store.** `skipOnError: true`
  (`plugins/security.ts:645`) means that if the counter store ever fails there is
  effectively no rate limit. The in-memory store cannot fail, and the comment says so
  honestly, but the failure mode changes the day Redis is introduced. Not a finding today;
  flagged because the fix is a decision, not a patch.
* **Timing side channels** (THREAT-MODEL T16). `timingSafeEquals` is used for the
  security-relevant comparisons I found, but I did not perform statistical timing
  measurement.

---

## Artefacts

Scripts and captured output live in this session's scratchpad:

* `leakhunt.mjs` — two-player fold-ended hand, all frames, reviews, authz probes
* `showdown.mjs` — showdown hand, Merkle reveal scope, Coach over WS
* `deepscan.mjs` — structural (not textual) leak scan over captured frames
* `oidc-test.mjs` — redirect, alg, discovery, PKCE, cookie-unpack adversarial cases
* `hostile.mjs`, `hostile2.mjs`, `hostile3.mjs` — CSRF coverage, hostile bodies, WS limits
* `session-test.mjs` — revocation, fixation, tampered cookies, cross-user
* `depgraph.mjs`, `integrity.mjs` — independent dependency graph, registry integrity, SBOM
* `redact-test.mjs`, `imp-test.mjs` — redaction and impersonation-guard gaps
* `A-frames.json`, `B-frames.json`, `sd-A.json`, `sd-B.json`, `review-A.json`,
  `review-B.json`, `sd-review-A.json`, `sd-review-B.json` — raw captures
