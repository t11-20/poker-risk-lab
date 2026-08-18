# Agent E — Testing & Reliability: independent release review

**Repository:** `/Users/terence/Projects/exploration-sites/poker-risk-lab`
**Reviewed:** 2026-08-18, tree as it stood between 16:20 and 17:40 UTC
**Toolchain observed:** Node v24.18.0, pnpm 11.10.0, PostgreSQL 16 in Docker (healthy), API on
`127.0.0.1:3001`, web on `127.0.0.1:3000`
**Verdict:** **FAIL** — one P0 (the release gate and the whole CI pipeline cannot pass), three P1.

The test suite that exists is, in craft terms, among the best I have reviewed: seeded fuzz with
asserted coverage, Proxy-instrumented information-flow proofs, published-constant cross-checks,
detectors that prove they can fail. The failures below are almost entirely about **what is not
wired up** — a broken release gate, a load harness that has never run, a critical journey with no
automated coverage, and 56 tests that silently do not run under the documented command.

---

## 0. Environment contamination (not a repo defect — read this first)

Four files belonging to another reviewer were present in the tree during my run:

```
./packages/poker-ai/test/zz-review-probe.test.ts     ("INDEPENDENT REVIEW PROBE — Agent F. Delete after review.")
./packages/poker-ai/test/zz-review-quality.test.ts
./packages/poker-ai/test/zz-review-stats.test.ts
./packages/poker-math/test/zz-review-coach.test.ts
```

They matter for three reasons, and I have excluded their effects from every finding below:

1. They **break `pnpm run lint`** — all 6 reported errors trace to them (`Found 6 errors. Found 2
   warnings.`; the 2 warnings are pre-existing `noExcessiveCognitiveComplexity` on
   `packages/content/src/validate.ts:670` and `:865`, which biome reports at warning severity and
   which exit 0 on their own).
2. They **break `pnpm run typecheck`** — 5 errors in `@prl/poker-ai`. I re-ran the package's
   `tsconfig.test.json` equivalent with those three files excluded: **exit 0**. So the real tree
   typechecks cleanly, tests included.
3. They made my first determinism measurement look non-deterministic (poker-ai reported 137, 137,
   139 tests across three runs). The two extra tests were the probe file appearing mid-session, not
   flakiness. Re-running poker-ai's six real test files three times gave **137 / 137 / 137**.

`packages/ui/src/components/PlayingCard.tsx` and `apps/web/src/styles/play.css` were also modified
by another agent mid-review.

---

## 1. Everything I ran, with the real result

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm run test` (×3) | **PASS** | 357 tests, 356 pass, 1 skipped, 0 fail. 27.5 s. Identical all three runs. |
| `pnpm run test:unit` | PASS | 6 of 9 workspace projects. poker-engine 85, contracts **0**, poker-math 187, ui 169, content 13, poker-ai 137. |
| `pnpm run test:integration` | PASS | 357 total incl. api 191; **56 DB tests silently skipped** (no `DATABASE_URL`). |
| api suite **with** `DATABASE_URL` | PASS | **414** tests, 414 pass, 0 skipped. |
| api suite with default (parallel) concurrency | PASS | 414/414 — no ordering dependence. |
| `pnpm run test:exhaustive` | **PASS** | 133,784,560 hands in 6.6 s (20,257k hands/s), 2 tests. |
| `pnpm run test:a11y` | **PASS** | 6 routes, 0 violations. |
| `node scripts/check-contrast.mjs` | **PASS** | Token + rendered layer, both themes. |
| `pnpm run test:smoke` | **PASS** | 37 checks (docs say 36). Zero WebSocket coverage. |
| `pnpm run db:verify` | **PASS** | 121 columns, 41 indexes, 13 tables' privileges. |
| `pnpm --filter @prl/poker-ai test:simulation` | **PASS** | 18 tests, 113 s. **Run by no root script and no CI job.** |
| `pnpm run test:load` | **FAIL** | 0 sessions, 0 connections, 0 hands, 100% error rate. See P1-1. |
| `pnpm run lint` | FAIL (contaminated) | Clean on the real tree apart from 2 pre-existing warnings. |
| `pnpm run typecheck` | FAIL (contaminated) | Clean on the real tree, `test/` included. |
| `pnpm run build:packages` | PASS | exit 0. |
| **`pnpm run security:audit`** | **FAIL (×2 runs)** | See P0-1. |
| **`pnpm run verify`** | **FAIL** | Dies at step 1; never reaches lint, typecheck, build or test. |
| `pnpm run db:seed` (×2) | PASS | Idempotent, verified empirically. |

Determinism: **no flakiness found.** Three full-suite runs produced identical counts; the api suite
passes both serially (`--test-concurrency=1`, as scripted) and in parallel; poker-ai is stable at
137 across three runs once the stray files are excluded.

Disabled tests: **no `.only`, no `.todo`, no `if (false)`, no commented-out assertions, no
swallowing `try {} catch {}` anywhere in any test file.** The only `skip:` markers are the five
`DATABASE_URL` guards, and each prints a reason. The `if (TEST_DATABASE_URL === undefined) return;`
early returns are in `before`/`after` hooks whose `describe` carries the matching `skip:` — honest,
not hidden.

---

## P0

### P0-1 — `pnpm run security:audit` fails deterministically; CI cannot go green and `pnpm run verify` never runs the tests

**Location:** `scripts/supply-chain/policy-check.mjs:59-62` and `:95-106`; interaction with
`pnpm-workspace.yaml:31` (`verifyDepsBeforeRun: error`).

**Problem.** The documented release gate fails 100% of the time. `policy-check.mjs` asks pnpm for
its *effective* config by shelling out to `pnpm config list --json` — but when it is itself invoked
from a pnpm script, pnpm has already injected `pnpm_config_verify_deps_before_run=false` into the
environment to suppress re-verification on nested invocations. The gate reads pnpm's own suppression
flag as the repository's policy and declares the policy absent.

Because `supply-chain` is the CI gate that `lint`, `typecheck`, `test`, `exhaustive`, `build` and
`a11y` all `needs:`, **every CI job is blocked**. And `pnpm run verify`
(`security:audit && lint && typecheck && build && test`) dies at step 1, so the composite release
command never runs a single test.

**Reproduction.**

```
$ pnpm run security:audit
  ✗ policy setting not in effect: verifyDepsBeforeRun = false
      required because: refuse to run against a stale node_modules
      set it in pnpm-workspace.yaml (NOT .npmrc — pnpm 11 ignores policy keys there)
  ✗ policy-in-effect — 1 failure(s)
...
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

Twice in a row, exit 1 both times. Also fails identically with the documented
`pnpm run security:audit -- --offline`. And:

```
$ pnpm run verify
1 gate(s) failed — this is release-blocking.
[ELIFECYCLE] Command failed with exit code 1.     ← never reaches lint/typecheck/build/test
```

**Evidence — the root cause, proven.** The same script passes when not run through pnpm:

```
$ node scripts/supply-chain/policy-check.mjs
  · 12 policy settings asserted against pnpm's effective config
  · packageManager pinned with integrity hash (pnpm@11.10.0)
  ✓ policy-in-effect — pass
```

The injected variable, and the value the gate therefore reads:

```
$ pnpm exec env | grep -i verify
pnpm_config_verify_deps_before_run=false

# from inside a pnpm-spawned process, the same call the gate makes:
env verify keys: [ [ 'pnpm_config_verify_deps_before_run', 'false' ] ]
verifyDepsBeforeRun = false

# from an ordinary shell:
$ pnpm config get verifyDepsBeforeRun
error
```

The policy itself is correctly configured (`pnpm-workspace.yaml:31` → `verifyDepsBeforeRun: error`),
and the gate's own predicate would accept it (`expect: (v) => v === 'error' || v === true`). This is
a detection bug in the gate, not a policy hole — but it is release-blocking by the project's own
stated rule ("Supply-chain findings are never waived to unblock a release") and it stops CI dead.

**Fix.** Read the setting from a source pnpm does not override for nested runs. Either (a) delete
`pnpm_config_*` keys from the child environment before the `execFileSync` — `env: { ...process.env }`
with `pnpm_config_verify_deps_before_run` removed — or (b) resolve the value from
`pnpm-workspace.yaml` plus `~/.config/pnpm/rc` directly and keep the `pnpm config` read only for
settings pnpm does not self-suppress. Whichever is chosen, the gate must state in a comment which
keys pnpm injects into script environments, or this will regress.

**Missing test.** There is **no test anywhere for `scripts/**`** (verified: no test file references
`scripts/`). Add a test for `policy-check.mjs` that runs it (i) from a bare environment and (ii) with
`pnpm_config_verify_deps_before_run=false` pre-set, and asserts the verdict is the same in both — the
exact discrimination this defect turns on. More broadly, each of the eight gates should have a
fixture proving it fails on a crafted violation and passes on the real lockfile; today the eight
gates that decide whether the product may ship are themselves entirely unverified.

---

## P1

### P1-1 — `pnpm run test:load` has never worked: three wrong route constants and CSRF sent too late. It measures nothing.

**Location:** `scripts/load-test.mjs:89-93` (`ROUTES`) and `:421-437` (`Session.createGuest`).

**Problem.** The harness points at endpoints that do not exist and does not obtain a CSRF token
before its first mutating request, so it dies on request one, every time.

| `scripts/load-test.mjs` | Real route (`apps/api/src/routes/`) |
| --- | --- |
| `guest: '/api/v1/session/guest'` | `POST /api/v1/auth/guest` (`auth.ts:383`) |
| `session: '/api/v1/session'` | `GET /api/v1/auth/session` (`auth.ts:400`) |
| `joinRoom: (roomId) => '/api/v1/rooms/${roomId}/join'` | `POST /api/v1/rooms/join` (`rooms.ts:279`), invite code in the body |

And `createGuest()` POSTs before a token exists:

```js
  async createGuest() {
    const created = await this.request(ROUTES.guest, {   // ← this.csrfToken is still null here
      method: 'POST',
      body: { displayName: this.name },
    });
    // The guest response is a SessionResponse; if a server ever stops returning
    // the token there, fall back to a plain GET rather than sending no header and
    // failing every later request with csrf_failed.
    this.csrfToken = created?.csrfToken ?? null;
```

`request()` only attaches the header when a token is already held
(`if (this.csrfToken && method !== 'GET') headers['x-csrf-token'] = this.csrfToken;`). The comment
anticipates the exact failure it then causes. `scripts/smoke-test.mjs:150-160` does it correctly —
`GET /api/v1/auth/session` first, `setCsrf(...)`, then POST.

**Reproduction.**

```
$ pnpm run test:load
  x table 0 failed: POST /api/v1/session/guest -> 403 forbidden: You do not have access to that.
  ...
  guest sessions          0
  connections             0 established of 0 attempted
  hands completed         0 of 5
  actions sent/applied    0 / 0
  rate 100.000% of 2 operations
FAIL
  - completed 0 of 5 hands
  - error rate 100.00% exceeds the 1.00% threshold
```

The first 403 is the CORS origin check, not CSRF: the harness defaults to
`origin: 'http://127.0.0.1:3000'` (`:108`) while `.env` / `.env.example` set
`PUBLIC_WEB_ORIGIN=http://localhost:3000`, and the allowlist is exact-string. Supplying the
allowlisted origin exposes the next layer:

```
$ node scripts/load-test.mjs --origin http://localhost:3000
  x table 0 failed: POST /api/v1/session/guest -> 403 csrf_failed: That request could not be verified.
```

Note the wrong path never surfaces as a 404 — every unknown route answers `content_not_found`
("That lesson, quiz or scenario does not exist.", `apps/api/src/errors.ts:401`), a deliberate
anti-enumeration choice that also hid this bug:

```
$ curl -s http://127.0.0.1:3001/nope
{"error":{"code":"content_not_found","message":"That lesson, quiz or scenario does not exist.",...}}
```

**Evidence that the harness is otherwise sound.** I copied it to a scratch file and changed exactly
four things — the three route constants, plus a `GET ROUTES.session` to seed the token before the
guest POST:

```
$ node /tmp/.../lt.mjs --origin http://localhost:3000
  guest sessions          3
  rooms created           1
  joins                   2
  connections             3 established of 3 attempted
  seats taken             3
  hands completed         5 of 5
  actions sent/applied    58 / 57
  p50 0.3ms   p90 0.6ms   p99 1.7ms   max 1.7ms   n=57
  server messages/second  4522.7
  Errors  none   rate 0.000% of 70 operations
PASS
```

So the design is genuinely good — it drives real hands off the server's own `legalActions`, copies
`expectedSequence` from the view it is answering, and uses a unique `actionId` per attempt. It has
simply never been executed against this API.

A second, separate problem surfaces once it runs: at any useful scale it trips the API's own rate
limiter and there is no flag or documented override.

```
$ node /tmp/.../lt.mjs --origin http://localhost:3000 --tables 4 --seats 6 --hands 15
  guest sessions          7
  Errors      4  rate_limited      4  transport:table-failed
FAIL  - completed 0 of 60 hands
```

The word "rate" appears nowhere in `scripts/load-test.mjs` except in a PRNG expression and one
unrelated comment, and `docs/RUNBOOK.md:71` lists the command as "configurable" with no caveat.

**Fix.** Correct the three `ROUTES` entries; seed the CSRF token with a `GET ROUTES.session` at the
top of `createGuest()`; default `origin` to match `.env.example`'s `PUBLIC_WEB_ORIGIN`
(`http://localhost:3000`) or resolve it from the environment; document that a multi-table run needs
`RATE_LIMIT_MAX` raised, and print the required value when a `rate_limited` error is seen.

**Missing test.** (a) A CI job that runs `pnpm run test:load` against a started API with a raised
limit — the harness is the only real-socket coverage in the repo and nothing currently executes it.
(b) A unit test asserting every path in `load-test.mjs`'s `ROUTES` and in `smoke-test.mjs` is present
in the assembled app, cross-checked against the manifest that
`apps/api/test/wiring.test.ts:71-107` already maintains. That test proves the *server* serves 25
routes; nothing proves the harnesses *call* those 25.

### P1-2 — Nothing in the repo opens a real WebSocket. The core journey has no working automated coverage.

**Location:** `apps/api/src/ws/hub.ts:180-296` (`createWsHub`) — registered by
`apps/api/src/routes/index.ts:50`, instantiated by no test. `apps/api/test/ws-router.test.ts` drives
`WsRouter` directly with a recorder sink.

**Problem.** Every WebSocket test exercises either the router with a fake sink or two pure functions
(`evaluateUpgrade`, `compileFrameValidator`). The plugin that turns a real HTTP upgrade into a live
connection is never registered in a test, so none of the following is covered:

- the **heartbeat** loop and `terminate()` of a socket that has missed two pings
  (`hub.ts:214-224`) — the mechanism that stops a half-open connection holding a seat's turn open;
- the **per-session socket counter** `bySession` (`hub.ts:201`, `:268`, `:286-289`): increment on
  open, decrement on close, delete at zero. A leak here locks a user out after reconnects, and the
  cap test only feeds `socketsForSession` to a pure function:
  `evaluateUpgrade({ origin: ALLOWED_ORIGIN, userId: 'usr_a', socketsForSession: WS_LIMITS.maxSocketsPerSession })`
  — the accounting that produces that number is untested;
- `toBytes` (`hub.ts:297-300`), i.e. a fragmented `Buffer[]` frame;
- the real `ws` upgrade path, cookie-borne session, and `onClose` teardown.

`grep -rn "new WebSocket" apps packages` returns only `scripts/load-test.mjs:491` — and that script
is broken (P1-1). `pnpm run test:smoke` never opens a socket at all:
`grep -c "WebSocket" scripts/smoke-test.mjs` → 0. So "36 checks end-to-end against a RUNNING api"
covers REST only.

**Reproduction / evidence.**

```
$ grep -rn "createWsHub\|wsHub" apps/api/test/*.test.ts
(no output)

$ grep -rn "from 'ws'\|new WebSocket" --include='*.ts' --include='*.mjs' apps packages scripts | grep -v node_modules
scripts/load-test.mjs:491:      const socket = new WebSocket(this.wsUrl(), {
apps/api/src/ws/hub.ts:10: * ##  handshake. Page script also cannot set a header on `new WebSocket()`, ##
apps/api/src/plugins/security.ts:615:   * at all: browser script cannot set a header on a `new WebSocket()` handshake, and
```

`apps/api/test/wiring.test.ts:105` does assert `GET /api/v1/ws` is *registered* — but never connects.

**Fix.** Add an integration test that starts the assembled app on an ephemeral port, obtains a
session cookie, and connects with `ws` (already a devDependency of `@prl/api`). Cover: successful
handshake and `welcome`; the socket-cap counter across open→close→open; a fragmented `Buffer[]`
frame; a socket that stops answering pings being terminated after two misses; a drop mid-hand
followed by a reconnect that receives the current view.

**Missing test.** As above, plus: two sockets for one session (below the cap) both receiving
recipient-specific state, and the upgrade being refused when the cookie is absent — currently only
asserted through the pure `evaluateUpgrade`.

### P1-3 — `pnpm run test` silently skips 56 database tests, including six that verify the hidden-information guardrail

**Location:** `package.json` — `"test": "pnpm run test:unit && pnpm run test:integration"`,
`"test:integration": "pnpm --filter @prl/api test"`; `apps/api/package.json` —
`"test": "node --test --test-concurrency=1 'test/**/*.test.ts'"`. Neither passes
`--env-file-if-exists=../../.env`, unlike every `db:*` script in the same file.

**Problem.** With no `DATABASE_URL` in the environment, four whole suites plus the database half of
`repositories.test.ts` skip. The documented local command therefore reports 357 green tests while
exercising **zero SQL**, and `pnpm run verify` — the release command — inherits that.

**Reproduction.**

```
$ pnpm run test
﹣ GET /hands # DATABASE_URL is not set, so the hand routes cannot be exercised against a table
﹣ GET /hands/:handId # DATABASE_URL is not set, ...
skipping the API-level hidden-information route tests: DATABASE_URL is not set, ...
﹣ GET /hands/:handId over HTTP # DATABASE_URL is not set, ...
ℹ tests 357   ℹ pass 356   ℹ fail 0   ℹ skipped 1

$ (cd apps/api && DATABASE_URL='postgresql://poker:poker-dev-only@127.0.0.1:5432/poker_risk_lab' \
     node --test --test-concurrency=1 'test/**/*.test.ts')
ℹ tests 414   ℹ pass 414   ℹ fail 0   ℹ skipped 0
```

**Evidence.** Diffing the two runs' test names, these are among the 56 that only run with a database
— every one of them is a check on the release-blocking "hidden cards and deck order never leak"
guardrail at the HTTP/DB layer:

```
serves each player their own cards and never the other’s
sends no deck, no cursor and no salt over the wire
never puts a hole card in a list row
has no column for the deck or the salts, and this proves it
returns hole cards only for the viewer own seat
opens a seat cards to everyone once it has shown down, and not before
```

The rest cover invite-code digests, seat contention, table-full rejection, keyset pagination,
`actionId` idempotency at the repository, double-settle rejection, session revocation and sliding
expiry, OIDC attempt single-consumption, and audit-log redaction.

`.github/workflows/ci.yml` **does** set `DATABASE_URL` for the `test` job, so CI covers these. The
defect is that the documented developer and release commands do not, and the suite reports success
rather than telling you it degraded.

**Fix.** Add `--env-file-if-exists=../../.env` to `@prl/api`'s `test` script (matching the `dev`
script, which already has it). Separately, make the degradation loud: print a single banner at the
end of the api run — `WARNING: N database suites were skipped; this run proves nothing about SQL` —
and consider a `test:integration:strict` that exits non-zero if `DATABASE_URL` is unset, used by
`pnpm run verify`.

**Missing test.** A meta-assertion in the api suite: when `DATABASE_URL` *is* set, assert
`skipReason === null` for every guard, so a future refactor that leaves a guard permanently true
(a typo in the env var name, say) fails instead of quietly skipping forever.

---

## P2

### P2-1 — `packages/contracts` ships an empty `test/` directory; its suite reports `tests 0` and exits 0

**Location:** `packages/contracts/test/` (empty), `packages/contracts/package.json` →
`"test": "node --test 'test/**/*.test.ts'"`.

```
$ ls -la packages/contracts/test/
total 0
drwxr-xr-x@ 2 terence  staff   64 17 Aug 19:54 .

$ (cd packages/contracts && node --test 'test/**/*.test.ts')
ℹ tests 0   ℹ suites 0   ℹ pass 0   ℹ fail 0
```

`pnpm run test` reports this package as passing. The package holds every request/query/WebSocket
JSON Schema, the wire protocol, and the error catalogue. Checking which exports any test file
mentions:

```
isErrorCode            NO TEST FILE REFERENCES IT
isClientMessageType    NO TEST FILE REFERENCES IT
wsError                NO TEST FILE REFERENCES IT
ALL_SCHEMAS            NO TEST FILE REFERENCES IT
PATTERNS               NO TEST FILE REFERENCES IT
ERROR_STATUS           NO TEST FILE REFERENCES IT
ERROR_MESSAGES         apps/api/test/security-headers.test.ts apps/api/test/rooms.test.ts
WS_LIMITS              apps/api/test/ws-router.test.ts
WS_CLOSE               apps/api/test/ws-router.test.ts
```

Mitigating: `ERROR_STATUS`/`ERROR_MESSAGES` are `Readonly<Record<ErrorCode, …>>`, so exhaustiveness
is a compile-time property; a missing `ALL_SCHEMAS` entry would break `app.ready()`, which
`wiring.test.ts` calls; and `PATTERNS`' id regex is cross-checked from the api side
(`repositories.test.ts:112-125` validates a generated id against the generator, the migration domain
`prl.prefixed_id`, *and* the router's `ID_PATTERN` — a genuinely good three-way check).

**Fix.** Either write the package's tests or delete the empty directory and the vacuous script so
the suite stops reporting a zero-test package as green. Concretely worth testing directly:
`isErrorCode`/`isClientMessageType` on hostile input; `wsError`'s shape; every schema in
`ALL_SCHEMAS` compiled against a matrix of accept/reject fixtures (the closed `additionalProperties:
false` contract is load-bearing and only sampled today); each `PATTERNS` regex against a crafted
near-miss.

**Missing test.** Also a guard in `test:unit` that fails when any package reports `tests 0` — a
package whose suite runs nothing must not be indistinguishable from one that passes.

### P2-2 — The `Math.random` ban is enforced over 2 of 7 source trees, and one source comment claims a test that does not exist

**Location:** `packages/poker-ai/src/policy.ts:254`; guards at
`apps/api/test/server-randomness.test.ts:118` (scans `apps/api/src` recursively) and
`packages/poker-engine/test/rng.test.ts:28` (scans `packages/poker-engine/src`, one level).

`policy.ts:254` states:

```ts
  /** Injected. `Math.random` is banned in this package and asserted absent. */
```

It is not asserted absent. There is no scan in `packages/poker-ai/test/` at all:

```
$ grep -rn "Math.random\|readdirSync\|SRC_DIR" packages/poker-ai/test/*.ts
(no output)
$ grep -rn "readdirSync\|SRC_DIR" packages/poker-math/test/*.ts packages/ui/test/*.ts
(no output)
```

Unscanned trees include `packages/poker-math/src` — which contains `monteCarloEquity` and the
variance simulations, precisely where reaching for `Math.random()` is tempting — plus
`packages/poker-ai/src`, `packages/ui/src`, `packages/content/src`, `packages/contracts/src` and
`apps/web/src`. A full-repo grep confirms **no violation exists today** (every hit is prose or the
guard tests themselves), so this is a guard gap, not a live defect.

Secondary: `rng.test.ts:33` iterates `readdirSync(SRC_DIR, …)` without recursion, so a future
`packages/poker-engine/src/<subdir>/` is silently skipped. `poker-engine/src` is currently flat.

**Fix.** Promote the scanner in `server-randomness.test.ts` (which is well built — it recurses,
strips comments, and proves each detector fires) into a shared test helper and run it over every
`src/` tree in the monorepo including `apps/web/src`; make every walker recursive; and either add the
assertion `policy.ts` claims or correct the comment.

**Missing test.** `packages/poker-ai/test/no-math-random.test.ts` (and equivalents), each with the
companion "the scan would actually catch a violation" case that
`rng.test.ts:41-45` and `server-randomness.test.ts:182-197` already model.

### P2-3 — The strongest AI-Legends evidence in the repo is run by no script and no CI job

**Location:** `packages/poker-ai/test/simulation/profile-differentiation.test.ts` (835 lines,
18 tests, 113 s); `packages/poker-ai/package.json` →
`"test:simulation": "node --test --test-timeout=1800000 'test/simulation/**/*.test.ts'"`.

The package's `test` script globs `test/*.test.ts` (one level), so the simulation suite is excluded
from `test:unit`. The root `package.json` has no `test:simulation`; `test:all` is
`test && test:exhaustive && test:a11y`. `.github/workflows/ci.yml` has jobs `supply-chain`, `lint`,
`typecheck`, `test`, `exhaustive`, `build`, `a11y` — and none of them invokes it. `docs/RUNBOOK.md`'s
test table does not mention it. The only way to run it is
`pnpm --filter @prl/poker-ai test:simulation`, which I had to construct myself.

It is the only thing that substantiates "profiles differ measurably", and it does so well — 8,000
hands per profile, two-proportion z-tests at α = 0.001, Spearman ρ of declared vs observed VPIP
(1.0000), cross-seed ρ (0.9930), byte-identical reproduction under a fixed seed, and a six-max
re-measurement. Also unrun by CI: `test:smoke` and `db:verify`, both of which pass and both of which
assert things nothing else does (`db:verify` checks the live schema's security properties;
`test:smoke` checks the no-currency-framing and no-endorsement guardrails on live payloads).

**Fix.** Add root `test:simulation`, `test:smoke` and `db:verify` scripts to `test:all`, and CI jobs
for each (the simulation suite can be nightly if 2 minutes is unwelcome on every push, but it must
be gated somewhere). List them in `docs/RUNBOOK.md`.

**Missing test.** A guard asserting that every `scripts` entry in every workspace `package.json`
whose name starts with `test` is reachable from a root script or a CI job — the class of defect here
is "a good test nobody runs", and it recurs silently.

### P2-4 — No test submits two actions for the same hand concurrently; `enqueue` is the only defence and it is untested

**Location:** `apps/api/src/rooms/table.ts:325-332` (`enqueue`), `:583` (`submitAction`);
`apps/api/test/ws-router.test.ts:456` (dedupe), `:499` (stale sequence).

```ts
  private enqueue<T>(work: () => T): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
```

Every mutation goes through this, and `grep -rn "enqueue" apps/api/test/*.test.ts` returns nothing.
The existing tests are strictly sequential — "deduplicates a repeated actionId and applies it once"
sends the duplicate *after* the first has resolved, and "rejects a stale expectedSequence" likewise.
Neither exercises the interleaving the serialisation exists to prevent. `grep -rn "Promise.all"
apps/api/test/*.test.ts` finds one use, in `hidden-information-api.test.ts:460`, unrelated to action
submission.

Related, from my brief's checklist and confirmed absent: no test for two sockets on one session
below the cap; no test that the socket-cap counter decrements on close (see P1-2).

**Fix / missing test.** `await Promise.all([table.submitAction(u, a1), table.submitAction(u, a2)])`
with two distinct `actionId`s and the same `expectedSequence`, asserting exactly one resolves and the
other rejects `stale_action_sequence`; the same with an identical `actionId`, asserting both resolve
to the *same* memoised outcome and the state advanced once; and a third with the bot runner's timeout
firing inside the same tick as a player action.

### P2-5 — The migration runner and the schema verifier export nothing, so their failure paths are untestable

**Location:** `apps/api/scripts/migrate.mjs` (no `export` statements),
`apps/api/scripts/verify-schema.mjs` (likewise), `MIGRATIONS_DIR` hard-coded at
`migrate.mjs:82`.

Untested and unreachable from a test: checksum drift (`planMigrations` → `describeDrift`,
`migrate.mjs:357-392`), orphan detection (`:400`), the advisory lock and its wait timeout
(`PRL_MIGRATE_LOCK_WAIT_MS`, `:619`), and the production seed guard (`:520`). This is item 8 on my
brief ("migration checksum mismatch") and it is not covered.

I did verify empirically what I could: `pnpm run db:migrate:status` reports
`2 applied and matching, 0 pending`, and `pnpm run db:seed` run twice in a row exits 0 both times
(the seed is genuinely idempotent — every insert ends `ON CONFLICT (id) DO NOTHING`).

**Fix.** Export `planMigrations`, `checksumOf` and `describeDrift`, and make `MIGRATIONS_DIR`
overridable (parameter or env), so a test can point it at a fixture directory.

**Missing test.** `planMigrations` against fixtures: a drifted checksum throws and names both
digests; an orphan in the ledger with no file is refused; pending files are returned in filename
order; the production guard refuses `seed` when `NODE_ENV=production`. Plus an integration test that
migrates a throwaway database, mutates one migration file, and asserts the second run aborts having
applied nothing.

### P2-6 — Smoke-test checks that pass vacuously, and warnings that cannot fail the run

**Location:** `scripts/smoke-test.mjs:421-452` (section 8), `:450-451`, `:475-481`, `:37-49`.

Three distinct weaknesses in the script the brief describes as "36 checks end-to-end":

1. **Section 8's hidden-information checks are vacuous.** The fixtures never play a hand, so both
   histories are empty. Observed output: `✓ hand history reads  0 hand(s)`. `collectKeys` over
   `{hands: []}` cannot contain `deck`/`deckCursor`/`deckSalts`/`salts`, so
   `✓ the hand list exposes no deck, cursor or salt key` is unconditional. And
   `✓ Bob's hand history does not contain Alice's hands` compares two empty sets:

   ```js
   const aliceIds = new Set((aliceHands.json?.hands ?? []).map((h) => h.id));
   const overlap = (bobHands.json?.hands ?? []).filter((h) => aliceIds.has(h.id));
   if (overlap.length === 0) ok("Bob's hand history does not contain Alice's hands");
   ```

2. **An assertion that disappears when the request fails.** `:441` —
   `if (bobHands.status === 200) { … }` with no `else bad(...)`. A 500 from Bob's history yields no
   check at all, passing or failing.

3. **`warn()` never fails the run** (`:37-49`, `:489-493` — only `failures` triggers
   `process.exit(1)`). So `:451` (`unknown hand` returning 500 instead of 404) and `:481` (no 429
   after 60 guest creations — i.e. rate limiting silently gone) both report a green run.

**Fix.** Have the smoke test seat two guests and play one hand over the WebSocket before section 8,
so the isolation checks have rows to be wrong about (this also closes part of P1-2). Add the missing
`else bad(...)`. Promote the two security-relevant `warn`s to `bad`, or make `warn` fail under a
`--strict` flag that CI passes.

**Missing test.** The smoke test *is* the test; the missing piece is a smoke assertion that the
fixture it depends on actually exists — e.g. `assert aliceHands.length >= 1` before the
no-leak scan, so an empty list is a failure rather than a free pass.

### P2-7 — 54 hand-authored multiple-choice answers have no verification of any kind

**Location:** `packages/content/data/quizzes.json`; `packages/content/test/scenarios.test.ts:317`
("numeric quiz questions ask for a field their calculation can actually produce").

The quiz set is 17 quizzes / 80 questions: `{ multipleChoice: 54, numeric: 24, decision: 2 }`. The
24 numeric answers are computed at runtime from `calculation.kind` + `field`, and the test verifies
the field is producible — good, and no hard-coded answer to be wrong. The 54 `correctIndex` values
are authored by hand and nothing checks them. An off-by-one teaches a learner something false and
marks a correct answer wrong.

I hand-verified all 9 multiple-choice questions whose prompt or options contain a number:
minimum-raise sizing (pot 30, bet 20 → total 40 ✓), three-way all-in side pots (20/100/100 → main 60
+ side 160 ✓), uncalled-portion return (80 back ✓), AhKh on Qh7h2c (ace high + flush draw ✓), best
possible on 9s9d4c (quad nines ✓), AA on 6c7c8d (straights already possible ✓), rule-of-2 rationale
✓, SPR uses the effective stack (120 ✓), and QQ combos with Qh on board and Qs in hand (one ✓).
**All nine are correct** — so this is a gap, not a live teaching error.

**Fix / missing test.** For every question whose answer is derivable, assert it: parse the numbers
out of the prompt and check the marked option against `@prl/poker-math` (the minimum-raise, side-pot
and combo-count questions above are all machine-checkable). For the genuinely prose ones, at minimum
assert the explanation mentions the marked option's substance, and require a second author's
sign-off field in the JSON that the test can check is present.

---

## P3

### P3-1 — `test:a11y` defaults to `crawlDepth: 1`, so CI audits six index routes and zero detail pages

`scripts/a11y-audit.mjs:153-165` — `routes: ['/']`, `crawlDepth: 1`, `maxRoutes: 12`. The default
run audits `/`, `/learn`, `/play`, `/lab`, `/legends`, `/review`. `apps/web/src/app` contains 13
`page.tsx` route templates; the seven detail templates (`/learn/[lessonId]`, `/learn/glossary`,
`/lab/[scenarioId]`, `/legends/[profileId]`, `/legends/compare`, `/legends/hand-review`,
`/review/[handId]`) are never audited even though the index pages link to them in server-rendered
HTML — `maxRoutes` is never reached, `crawlDepth` is what stops it.

I checked whether this hides anything, and it does not:

```
$ node scripts/a11y-audit.mjs --crawl-depth 3 --max-routes 40 --no-start
  routes audited      40
  violations          0
PASS
```

So: a coverage gap in the CI configuration with no latent defect behind it today. Raise the default
`crawlDepth` to 2 (or seed `--routes` with one instance of each dynamic template) so a regression on
a lesson, scenario or legend page is caught.

### P3-2 — Zero component render tests; `apps/web` has no test script at all

No test file in the repo imports a `.tsx`:

```
$ grep -rn "\.tsx'\|components/" --include='*.test.ts' --include='*.test.tsx' packages apps
(no output)
```

`packages/ui/src/components/` is 21 components / ~3,600 lines (CoachPanel 643, ActionBar 365,
PokerTable 310, Metric 313, Seat 222, RadarChart 181, TurnTimer 161). `apps/web/src` is 20,937 lines
with no `test` script — which is why `pnpm run test:unit` prints `Scope: 6 of 9 workspace projects`.
The React hooks (`useCountUp`, `useReveal`, `usePrefersReducedMotion`) are untested; `motion.test.ts`
covers only the pure easing/token/reduced-motion helpers.

The frontend requirement (design system, selective loading transition, section reveals, count-up
metrics, immersive table, premium Coach panel, Legend cards, Scenario Lab and Hand Review analytics,
responsive breakpoints, loading/error/completed-hand states, dark **and** light mode) therefore rests
entirely on: `tsc --noEmit`, a static markup audit of six routes, and `check-contrast.mjs` parsing
CSS tokens. That is real evidence but it is not behavioural evidence, and "WCAG 2.2 AA" is not
established — the audit's own header says so ("colour contrast, focus order and keyboard use still
need a browser run").

The 169 `@prl/ui` tests that do exist are good: `radar.test.ts` derives its geometry by hand (centre
120, radius 88, angle 0 → `{x:120, y:32}`) and covers NaN/negative/out-of-range clamping.

### P3-3 — A divergence test whose loop can execute zero times, and two unbounded profile axes

`packages/poker-ai/test/simulation/profile-differentiation.test.ts:345-363`. The only assertion
inside the loop is `assert.deepEqual(findImpersonation(sentence), [], sentence)`; if
`compareToDeclared` returned an empty `divergences` array the test would pass having asserted
nothing. The file is explicit that `aggressionFrequency` and `threeBetTendency` are deliberately not
bounded, and the reasons given are sound (declared as a neutral-hand rate and a range multiplier
respectively, not as unconditional frequencies) — but the consequence is that these two axes have no
declared-vs-observed check at all, and the current run tolerates gaps of roughly 2×:

```
adaptive-exploiter — threeBetTendency: declares 0.660 and the simulation measured 0.323 …
volume-grinder — threeBetTendency: declares 0.780 and the simulation measured 0.404 …
disciplined-specialist — aggressionFrequency: declares 0.520 and the simulation measured 0.331 …
```

Add `assert.ok(lines.length > 0)` or an explicit expected-divergence-key set so the loop cannot
vanish, and either bound these axes on their own scale or assert their *ordering* across profiles
(the test already does exactly that for VPIP, PFR and aggression via Spearman ρ — `0.9510` for
aggression — so the machinery exists).

### P3-4 — A fuzz coverage counter that is collected but not asserted

`packages/poker-engine/test/invariants.test.ts:163` counts `sawAllInPreflop` and prints it
(`all-in preflop 31`) but, unlike `reachedShowdown`, `endedByFold`, `sawSidePots` and `streetsSeen`,
never asserts on it (`:238-244`). Add `assert.ok(sawAllInPreflop > 0, …)` so a generator change that
stops producing blind-sized stacks is caught rather than merely printed.

### P3-5 — Documentation drift around the test commands

`docs/RUNBOOK.md:64-72` omits `pnpm run test:smoke`, `pnpm run db:verify` and the poker-ai
simulation suite; it lists `pnpm run test:load` as "configurable" with no note that it needs an
origin matching `PUBLIC_WEB_ORIGIN` and a raised rate limit. The brief describes the smoke test as
36 checks; it emits 37 (`37 check(s) passed`).

---

## 2. Test-quality assessment (the part that is genuinely good)

I read well beyond five tests per package looking for weak assertions. What I found, with evidence:

**No instance of any of the antipatterns I was asked to hunt for**, with one trivial exception:

- `assert.ok(x)` where `x` cannot be falsy: one bare `assert.ok` in the whole repo
  (`poker-engine/test/betting.test.ts:69`, `assert.ok(blinds.isHeadsUp)` — a boolean that can be
  false). The twelve `assert.ok(x >= 0)` hits are real non-negativity invariants on stacks, pots,
  awards, probabilities and SPR, all of which a bug can violate.
- Circular assertions (a test asserting a function returns what that function computed): none found.
  The opposite is systematically true — `odds.test.ts:290-325` brute-forces all C(47,2) = 1081
  run-outs, gets 378 with at least one heart, checks that the *evaluator* independently scores
  exactly those 378 as flushes, and then checks the closed form agrees to 1e-12.
  `odds.test.ts:363-400` derives the rule-of-4 error algebraically as `o·(100o − 652)/2162` and
  checks the implementation against the algebra at every out count 1–20.
  `poker-ai/test/stats.test.ts:147-163` recomputes the pooled z-statistic from first principles
  *and* asserts the fixture would distinguish the pooled from the unpooled formula.
  `stats.test.ts:101-110` pins the normal critical values to published tables including the
  interquartile point "which is a different part of the curve entirely, so it catches a tail formula
  that happens to be calibrated only where the conventional alphas sit."
- Expected values copied from the implementation: not found. The 133M-hand suite's nine expected
  frequencies (23,294,460 / 58,627,800 / 31,433,400 / 6,461,620 / 6,180,020 / 4,047,644 / 3,473,184 /
  224,848 / 41,584) are the standard published 7-card table, they sum to C(52,7), and the sum is
  itself asserted. I verified each figure against the published result.
- Swallowing `try/catch`: none. The one `try/catch` inside the fuzz loop
  (`invariants.test.ts:197-207`) asserts the caught message matches an expected rejection reason.
- Assertions after an early `return`: the five `if (TEST_DATABASE_URL === undefined) return;` are in
  `before`/`after` hooks with a matching `skip:` on the `describe`.
- Loops that can execute zero times: one meaningful case, P3-3.

**Fuzz and property tests are seeded and assert their own coverage.**
`invariants.test.ts:156-249` runs 4,000 hands from `createDeterministicRandomForTests(handIndex+1)`
with randomised player counts (2–6), blind levels, antes and deliberately sub-blind stacks, checks
every invariant after every action, and then asserts the run actually reached the interesting states:
`reachedShowdown > 200`, `endedByFold > 200`, `sawSidePots > 100`, and all four streets seen.
Observed: `4000 hands, 32245 actions | showdown 3518, folded 482, side pots 3114, all-in preflop 31`.
A companion test replays a seed for byte-identical output, and a third asserts an illegal action
never mutates state.

**The information-flow proof is the strongest test in the repository.**
`packages/poker-ai/test/no-hidden-information.test.ts` wraps the redacted view in a recording `Proxy`
that logs every property path at every depth, runs the real `decide()`, and then asserts the read set
is a subset of a closed allow-list, contains no forbidden path segment, and — notably — contains no
`holeCards` path *at all*, not even the seat's own. It guards against its own vacuity three ways:
`assert.ok(log.paths.length > 0, "the policy read nothing, so this proves nothing")`; a positive
requirement that `legalActions`, `seats`, `potTotal` and `amountToCall` *were* consulted; and a walk
that asserts all four streets were instrumented and `decisions > 20`. Then an invariance test builds
two hands differing only in an invisible opponent holding and asserts the decision, the whole action
distribution, the equity and the reasoning are identical — with `assert.notDeepEqual` proving the
opponent really does hold something different, and a companion test proving the two views differ
(different commitment roots) so the invariance cannot pass by the hands being the same hand.

**Guard tests prove their own detectors fail.** `apps/api/test/server-randomness.test.ts` and
`packages/poker-engine/test/rng.test.ts` each pair every source scan with a test that feeds it a
violation and asserts it fires, feeds it a prose mention and asserts it does not, and asserts the
walker found something to scan (`assert.ok(totalSql > 0, 'found no SQL at all in src/, so the SQL
rules below proved nothing')`).

**Content claims are computed, not asserted.** `packages/content/test/scenarios.test.ts:117-161`
checks every scenario's teaching point against live maths and reports the split:
`36/36 scenarios carry claims: 74 independent verification, 0 regression locks`, with
`assert.ok(verificationClaims >= 20)` so a suite that verified nothing cannot pass. Separate tests
forbid a computed percentage appearing as prose anywhere in scenario, lesson or quiz copy, forbid
gambling and dark-pattern language, forbid pass/fail framing, and assert syllabus spread (≥6 topics,
no topic above 40%).

**Worker-pool tests use real threads and check a mathematical relationship, not a constant.**
`apps/api/test/calc.test.ts:374-428` verifies that pooling four shards tightens the confidence
interval by √4 rather than 4 — `combined > oneShard / 4` and
`|combined − oneShard/2| < oneShard/4` — which is exactly the mistake (averaging the shards'
intervals) that the implementation exists to avoid. It also kills a thread that overruns a 1 ms
deadline and asserts `workers === 0` and `timedOut === 1`, then proves the pool still works;
rejects a third submission with `service_unavailable` when size 1 + queueLimit 1 are full; and
refuses work once closed.

**OIDC negative coverage is exhaustive.** `apps/api/test/oidc.test.ts` rejects `alg: 'none'` (twice
— once with a non-empty signature so it is provably the `alg` check that fires), the HMAC
algorithm-confusion attack signed with the provider's public key, an `iss` that only looks like ours,
an `aud` array without us, multiple audiences with a mismatched `azp`, a token just outside the clock
skew, a future `nbf`, a future/missing/stale `iat`, a wrong and a missing nonce, and an unknown `kid`
after exactly one refetch for rotation.

**All test directories are typechecked** with the same strict flags. Every package except `@prl/ui`
carries a `tsconfig.test.json` that widens `rootDir` and includes `test/**/*.ts` with no relaxation;
`@prl/ui`'s single `tsconfig.json` already includes `test/**/*.ts`. This closes the Node
type-stripping hole the brief warns about, and `packages/poker-ai/tsconfig.test.json` covers
`test/simulation/` too. **The `scripts/**/*.mjs` tree is not typechecked** — 1,000+ lines of
load harness, the smoke test, the a11y audit and eight supply-chain gates — which is how P1-1's wrong
route constants survived.

**Hostile input at the API boundary is handled correctly.** I probed `POST /api/v1/math/equity` on
the live server with a real session and CSRF token; every case behaved:

```
baseline AhAd vs KsKd     → 200, 0.8194605 exact-enumeration, 1712304 trials
duplicate card across hands→ 400 invalid_request "Ah is already held by hero"
hero holds AhAh           → 400 "heroCards contains the same card"
board repeats a hole card → 400 "the board repeats a card hero is holding"
samples 1e999 (Infinity)  → 400 "must be integer"
samples -1                → 400 "must be >= 1000"
samples 1500.5            → 400 "must be integer"
6 opponents               → 400 "must NOT have more than 5 items"
unicode range "♠♥"        → 400 pattern mismatch
6-card board              → 400 "a board has 0, 3, 4 or 5 cards"
unknown property          → 400 "is not a field this endpoint accepts"
wide range (expensive)    → 429 rate_limited, retryAfterSeconds 40
```

**Failure paths I could exercise behave correctly.** With `DATABASE_URL` pointed at a closed port on
a throwaway instance: `/health` → 200 (never touches the database), `/ready` → 503
`{"status":"degraded","checks":{"database":{"ok":false,"detail":"database did not answer"}}}`,
`POST /auth/guest` → 500 `internal_error` with no driver detail on the wire. The server-side log
carries the stack and `ECONNREFUSED 127.0.0.1:5499` but **not** the password — redaction holds. Only
the readiness-stub half of this is automated (`security-headers.test.ts:685-726`); the live-route
path is not, though it is correct.

---

## 3. Verification of the eight already-fixed defects

| # | Fix | Holds? | Evidence |
| --- | --- | --- | --- |
| 1 | `pnpm run` broken workspace-wide | **Partly — see P0-1** | `pnpm run` works everywhere; but `verifyDepsBeforeRun: error` now makes `pnpm run security:audit` fail, so the gate is broken in a new way. |
| 2 | Exhaustive suite in the default glob | **Holds** | `poker-engine` `test` globs `test/*.test.ts` (one level); `pnpm run test` is 27.5 s and 85 engine tests; the 133M suite runs only under `test:exhaustive`. |
| 3 | `.env.example` DB password | **Holds** | `.env`/`.env.example` and `docker-compose.yml` agree on `poker-dev-only`; `db:verify` and all DB tests connect. |
| 4 | API port disagreement | **Holds for the port; a new host mismatch exists** | `PORT=3001` everywhere and the API answers there. But `scripts/load-test.mjs:108` defaults `origin` to `http://127.0.0.1:3000` while `PUBLIC_WEB_ORIGIN=http://localhost:3000` — same class of defect, different axis (P1-1). |
| 5 | Session plugin scope / `GET /hands` 500 | **Holds** | Live `GET /api/v1/hands` → 401 `not_authenticated`, not 500. `wiring.test.ts:180-184` asserts exactly this with the reason in the message. |
| 6 | No-op archive; hands never persisted | **Holds** | After the patched load test played 5 hands: `prl.hands` 9 rows, `prl.hand_actions` 72, `prl.hand_seats` 25, `prl.rooms` 14. And no leakage: `select … from information_schema.columns where table_schema='prl' and (column_name ilike '%deck%' or column_name ilike '%salt%')` returns nothing. |
| 7 | Guest-creation rate-limit bypass | **Holds** | Smoke test: `✓ guest creation is rate limited  429 after repeated attempts`. Independently reproduced — my patched load run at 24 sessions got `4 rate_limited`. |
| 8 | Impersonation guard gaps | **Holds where I could reach it** | `findImpersonation` is asserted on every generated learner-facing sentence in `profile-differentiation.test.ts:357` and `stats.test.ts:191`; the live smoke test confirms `✓ no profile implies endorsement or a digital twin` and `✓ every profile carries at least one disclaimer` across 12 profiles. The specific two strings from the fix are Agent B/C's ground to re-verify. |

---

## 4. Honest verdict: requirements with no meaningful test behind them

**Well covered, with strong tests:** hand evaluation (exhaustive, 133,784,560 hands against published
frequencies); betting rules, min-raise increments, reopening, heads-up order, antes, all-ins, side
pots, odd-chip assignment, chip conservation (4,000-hand seeded fuzz with asserted coverage);
deck commitment and reveal verification incl. tamper cases; CSPRNG and unbiased Fisher–Yates;
redaction / hidden-information at the engine layer; AI-policy information flow (Proxy-instrumented);
outs, exact odds, rule of 2/4 with its error algebra, pot odds, break-even equity, EV, fold equity,
SPR, variance, risk of ruin, ICM; content claims (74 independent verifications over 36 scenarios);
OIDC token verification; CSRF on the whole mutating surface; security headers and error redaction;
worker-pool sharding, deadlines, queue limits and √N interval pooling; id entropy and three-way
pattern agreement; hostile input at the calculation endpoints.

**Covered only when someone remembers to set `DATABASE_URL`** (56 tests; CI does, local `verify`
does not): hidden-card confidentiality over HTTP, hand-history isolation and keyset paging,
invite-code digests, seat contention and table-full, repository-level `actionId` idempotency,
double-settle refusal, session revocation and sliding expiry, audit-log redaction.

**No meaningful automated test at all:**

1. **The live multiplayer journey over a real WebSocket** — handshake, sit, play a hand, reconnect.
   Zero coverage: no test opens a socket, the smoke test is REST-only, the load test is broken.
2. **The WebSocket hub's runtime machinery** — heartbeat and dead-socket termination, per-session
   socket accounting, fragmented frames.
3. **Concurrent actions on one hand** — `enqueue` is the only defence and nothing exercises it.
4. **Every React component and every page** — 21 components, 13 route templates, ~24,500 lines. No
   render test exists; `apps/web` has no test script.
5. **WCAG 2.2 AA behaviourally** — keyboard operability, focus order and management, computed-style
   contrast, post-hydration DOM, reflow, target size. The static audit says so itself.
6. **`@prl/contracts`** — empty `test/`; six exports referenced by no test.
7. **The eight supply-chain gates** — no test, and one of them is currently wrong (P0-1).
8. **The migration runner** — checksum drift, orphans, advisory lock, production guard.
9. **`scripts/**` generally** — not typechecked and not tested; 1,000+ lines of load harness plus the
   smoke test and a11y audit.
10. **54 multiple-choice quiz answers** — hand-authored `correctIndex`, unverified (the 9 I could
    check by hand are all correct).
11. **Bluff frequency, value/bluff balance, bet sizing, stack-depth adjustment, tournament-vs-cash
    and risk tolerance as *measured* profile axes** — VPIP, PFR and pairwise aggression/3-bet
    separation are measured and ordered; the remaining declared axes are reported but unbounded
    (P3-3). And the suite that does the measuring is run by nothing (P2-3).

**Release recommendation:** do not ship until P0-1 is fixed (the gate cannot pass and CI is red) and
P1-1/P1-2 are addressed (the one harness that would exercise the product's central journey has never
run). P1-3 is a one-line script change with a large evidence payoff.
