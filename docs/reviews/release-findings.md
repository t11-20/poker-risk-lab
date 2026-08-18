# Poker Risk Lab — deduplicated release findings

Lead coordinator's register for the `/review-harness` release review.

Seven reviewers (A–G) ran in parallel under a single barrier, so no reviewer could see
another's conclusions before forming its own. Each ran its own commands; none was given the
implementer's summary as evidence.

## Aggregate result

**All seven reviewers returned FAIL.**

| Reviewer | Scope | Verdict | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| **A** | Architecture & Integration | FAIL | 2 | 1 | 3 | 5 |
| **B** | Poker Rules & Mathematics (adversarial) | FAIL | 1 | 3 | 3 | 3 |
| **C** | Security & Supply Chain | FAIL | 0 | 1 | 3 | 3 |
| **D** | Frontend, UX & Accessibility | FAIL | 2 | 2 | 2 | 4 |
| **E** | Testing & Reliability | FAIL | 1 | 3 | 7 | 5 |
| **F** | AI Opponents & Educational Content | FAIL | 1 | 2 | 6 | 9 |
| **G** | Production & Operations | FAIL | 6 | 4 | 5 | 7 |
| | **Total (pre-dedup)** | **7× FAIL** | **13** | **16** | **29** | **36** |

94 findings before deduplication; 15 blocking clusters after.

## How this register was built

Two findings are treated as the same defect **only when fixing one necessarily fixes the
other**. Findings sharing a root cause but needing separate fixes stay separate — collapsing
those is how a cluster gets closed while half the defect is still live. Severity
disagreements are printed, not averaged; where I adjudicated against a reviewer I say so and
give the reasoning.

## What the reviewers converged on

The single most important pattern: **the server is largely real and the client largely is
not.** The API, engine and maths packages are substantial, server-authoritative and heavily
tested. The web application is, in the shipped build, a set of fixtures. Four reviewers
reached that conclusion by different routes (R1), and it explains why internal verification
— including my own — kept coming back green: the API was tested directly with correct paths,
and the web app rendered correctly from bundled data. Neither check ever asserted that the
client's requests reached the server.

The second pattern is narrower and worse: **one defect makes the app teach the wrong
answer** (R4). Everything else in this register is something that does not work. R4 is
something that works, presents itself as authoritative, and is wrong.

---

# Blocking clusters

## R1 — P0 — The web app is not connected to the API: every REST path 404s and every screen silently serves a bundled fixture

**Raised by:** Agent A, Agent D, Agent F, Agent G (4 independent reviewers)

**Lead assessment.** Four reviewers found this independently, which is the strongest signal in the
whole review. It is one defect with one fix, so it is one cluster — but Agent F's angle is
not a duplicate observation, it is an ESCALATION, and it changes what the fix has to
achieve. F points out that the bundled Legends fixture hard-codes attributed real-person
names, so the silent fixture fallback does not merely show stale data: it defeats the
`PRL_LEGEND_NAMING` opt-in entirely and ships attributed names to every deployment
regardless of configuration. That converts a wiring bug into a violation of an explicit
product guardrail ("provide configuration allowing production deployment with generic
archetype names"). Any fix that repairs the paths but leaves the fixture defaulting to
attributed names has not closed F's half.

The second-order defect matters as much as the paths. `isApiUnavailable()` counts a bare
404 as "the API is not deployed", which is what made a total disconnection invisible: no
error, no failing build, no failing test. A 404 on a path the client itself constructed is
a client bug and must be loud. Repairing the prefixes without repairing that predicate
leaves the next path typo just as silent.

### As reported by Agent A (P0) — Every REST path apps/web requests omits the /api/v1 prefix, so the whole web app silently runs on fixtures

**Location.** `apps/web/src/lib/api.ts:306; apps/web/src/lib/learn-data.ts:41-43; apps/web/src/lib/legends-data.ts:48-51; apps/web/src/app/lab/page.tsx:100; apps/web/src/app/lab/[scenarioId]/page.tsx:47; apps/web/src/app/review/page.tsx:126; apps/web/src/app/review/[handId]/page.tsx:41`

**Problem.** API_PREFIX is '/api/v1' (apps/api/src/app.ts:55) but no path in the web client includes it; the content paths also omit the '/content' segment. Every request 404s. Because isApiUnavailable() treats status===404 as "API unavailable", every screen silently falls back to a bundled fixture — no error, no failing build, no failing test. next.config.ts has no rewrites. Separately, legends-data.ts:49 calls '/api/legends/:profileId/learn' whose path *shape* is also wrong: the server route is GET /api/v1/legends/profiles/:profileId.

**Reproduction.**

```
check() { ws=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3001$1"); cs=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3001$2"); printf "%-30s -> %s | %-28s -> %s\n" "$1" "$ws" "$2" "$cs"; }

/api/session          -> 404 | /api/v1/auth/session      -> 200
/api/content/lessons  -> 404 | /api/v1/content/lessons   -> 200
/api/content/glossary -> 404 | /api/v1/content/glossary  -> 200
/api/scenarios        -> 404 | /api/v1/content/scenarios -> 200
/api/legends/profiles -> 404 | /api/v1/legends/profiles  -> 200
/api/hands            -> 404 | /api/v1/hands             -> 401

$ curl -s http://127.0.0.1:3000/lab | grep -o 'href="/lab/[a-z0-9-]*"' | sort -u
href="/lab/flop-flush-draw-price"
href="/lab/flop-spr-commitment"
href="/lab/preflop-set-mining-odds"
href="/lab/preflop-squeeze-fold-equity"
href="/lab/river-bluff-catch-range"
href="/lab/turn-gutshot-price"
(6 scenarios; API serves 36, and none of these 6 ids exists in packages/content/data/scenarios/)

$ curl -s http://127.0.0.1:3000/learn/bet-sizing   # HTTP 200
"Watch out — This lesson's text is not available in this build. The content service is not reachable and this lesson's body is not in the bundled copy, so there is nothing to show you."
```

**Evidence.** apps/web/src/lib/api.ts:96 — `return error.status === 404 || error.status === 501 || error.status >= 502;` is what converts a wiring bug into a silent one. Rendered /lab carries the developer-facing note "Fixture data The scenario API is not reachable, so this list comes from the typed fixture in src/fixtures/scenarios.ts". Content id diff: /learn lists all 17 lessons (summaries fixture is complete) but only 8 full lesson bodies are bundled, so 9 are dead ends: betting-actions, blinds-and-the-option, position-basics, all-ins-and-side-pots, reading-the-board, bet-sizing, ranges-and-combos, variance, tournament-chips-and-icm — i.e. most of the required syllabus (blinds, position, actions, side pots, sizing, ranges, variance, ICM). Requirement is "a Scenario Lab with 30+ scenarios"; the app has 6.

**Recommended fix.** Export a single API_PREFIX constant in apps/web/src/lib/api.ts and build every path from it, or prepend the prefix inside call() so no call site can forget it. Correct /api/scenarios* -> /api/v1/content/scenarios* and /api/legends/:id/learn -> /api/v1/legends/profiles/:id. Separately stop treating a bare 404 as "API unavailable": a 404 on a client-constructed path is a client bug and should be loud in development.

**Missing test.** An integration test that drives app.inject() on a real buildApp() instance for every path constant the web client can emit (LEARN_API_PATHS, LEGEND_API_PATHS, fetchSession's path, and the four inline template paths) and asserts none returns 404. Pure Fastify, no browser needed; it would have failed on day one.

### As reported by Agent D (P0) — Every web→API path 404s: the whole app runs on bundled fixtures (fix for known defect #4 is incomplete)

**Location.** `apps/web/src/lib/api.ts:306; apps/web/src/lib/legends-data.ts:47-52; apps/web/src/lib/learn-data.ts:41,43; apps/web/src/app/lab/page.tsx:100`

**Problem.** The web client omits the `/v1` version segment (and uses different sub-paths) on every single API call. The API mounts everything under /api/v1. Not one web→API request can succeed in any environment. Already-fixed defect #4 corrected the API *port*; the *path* axis was never corrected, so the condition that fix was meant to close ("the web client could not reach the API at all") is still open. Consequences observed: the shell's per-page session call 404s, so units and the CSRF token are always the fixture and no mutation is possible; every content screen renders bundled copy; 4 of 12 AI profiles are entirely unreachable and their detail routes render the 404 page.

**Reproduction.**

```
With the allow-listed origin so CORS is not a factor:
$ O="Origin: http://localhost:3000"
WEB PATH                                    -> STATUS   | LIKELY API PATH                        -> STATUS
/api/session                               -> 404     | /api/v1/auth/session                   -> 200
/api/content/lessons                       -> 404     | /api/v1/content/lessons                -> 200
/api/content/lessons/pot-odds              -> 404     | /api/v1/content/lessons/pot-odds       -> 200
/api/content/glossary                      -> 404     | /api/v1/content/glossary               -> 200
/api/scenarios                             -> 404     | /api/v1/content/scenarios              -> 200
/api/legends/profiles                      -> 404     | /api/v1/legends/profiles               -> 200
/api/legends/adaptive-exploiter/learn      -> 404     | /api/v1/legends/profiles/adaptive-exploiter -> 200
/api/legends/hands/hand-0042/comparison    -> 404     | /api/v1/legends/hands/hand-0042/comparison -> 404

And in the browser: /legends/old-school-pressure renders h1="Page not found", len=448.
```

**Evidence.** apps/web/src/lib/api.ts:306 — `return safeFetch<SessionResponse>(() => apiGet<SessionResponse>('/api/session', options));` whose own comment calls it "the one call the app shell makes on every page: it carries the reader's units for the header badge and the CSRF token every later mutation needs". `grep -n "api/v1" apps/web/src/lib/api.ts` returns nothing. apps/web/next.config.ts declares no rewrites ("Deliberately absent: any webpack or turbopack customisation, any redirect"), so the paths are used verbatim against API_ORIGIN. The 8th path has no server route at all — the API's legends routes are only /legends/profiles, /legends/profiles/:profileId, /legends/matches, /legends/compare (apps/api/src/routes/rooms.ts:361,394,421,487).

**Recommended fix.** Add one API_PREFIX = '/api/v1' constant in apps/web/src/lib/api.ts and build every path from it, then fix the four sub-paths that also differ in shape: /api/session → /api/v1/auth/session, /api/scenarios → /api/v1/content/scenarios, LEGEND_API_PATHS.learnFrom → /api/v1/legends/profiles/{id}. Implement or delete the hand-comparison endpoint rather than shipping a client path with no server route. Un-truncate apps/web/src/fixtures/legends.ts to all 12 profiles so the fallback matches the wire.

**Missing test.** An integration test that enumerates the web client's path constants and asserts each resolves to a real route on a booted Fastify instance (app.hasRoute() or a non-404). pnpm run test:smoke exercises the API's own paths, so it structurally cannot catch a client that asks for different ones — the contract test must be driven from the client's constants.

### As reported by Agent G (P0) — The web client calls unversioned /api/... paths while the API serves /api/v1/...; every request 404s and every page silently renders bundled fixtures

**Location.** `apps/web/src/lib/api.ts:306, apps/web/src/lib/learn-data.ts:37-43, apps/web/src/lib/legends-data.ts:44-51 versus apps/api/src/app.ts:55 (export const API_PREFIX = '/api/v1')`

**Problem.** The client's paths are marked in-source as 'Provisional endpoint paths. The API team owns the final names' and were never reconciled. They omit the version segment and several resource names differ as well, so the entire front end runs disconnected from the back end and every screen takes its fixture branch. Nothing surfaces it: the fallback copy reads as a transient outage, and one banner even leaks the content_not_found message onto the legends page.

**Reproduction.**

```
Built the web app clean with NEXT_PUBLIC_API_ORIGIN=http://localhost:3101, served it on :3200, ran a private API on :3101 with a matching origin allowlist, visited /, /play, /lab, /review, /learn, /legends, then read the API's own request log (first three lines are my own curl checks with the correct prefix; everything after is the web app):
  GET /api/v1/health            <- curl, 200
  GET /api/v1/ready             <- curl, 200
  GET /api/v1/content/lessons   <- curl, 200
  GET /api/session              404
  GET /api/scenarios            404
  GET /api/hands                404
  GET /api/content/lessons      404
  GET /api/legends/profiles     404
  GET /api/session              404   (x6 in total)
  === non-200 responses ===  3 x 200, 10 x 404
```

**Evidence.** Source comment at apps/web/src/lib/learn-data.ts:37: 'Provisional endpoint paths. The API team owns the final names; the `/api/…` prefix follows the...'. Mapping of client path -> what actually exists: /api/session -> /api/v1/auth/session; /api/content/lessons -> /api/v1/content/lessons; /api/content/glossary -> /api/v1/content/glossary; /api/legends/profiles -> /api/v1/legends/profiles; /api/legends/compare -> POST /api/v1/legends/compare (client GETs); /api/legends/:id/learn -> GET /api/v1/legends/profiles/:profileId; /api/legends/hands/:id/comparison -> no such route; /api/scenarios -> /api/v1/content/scenarios; /api/hands -> /api/v1/hands. User-visible result on /legends: 'These profiles are bundled sample data. The profile service is not reachable... (That lesson, quiz or scenario does not exist.)' and it shows '8 profiles · Naming: attributed' while GET /api/v1/legends/profiles returns 12 profiles with naming mode 'archetype'.

**Recommended fix.** Export the prefix and every route path from @prl/contracts and import them on both sides so a rename cannot diverge again. Two client paths have no server counterpart and three differ in shape or verb, so this is not a prefix-only fix. Make the fixture fallback loud outside production — a boot-time or build-time assertion that every client path is a registered route — because a silent fallback is what let this ship.

**Missing test.** A contract test enumerating every path the web client can request and asserting each is a registered API route; plus one end-to-end check that / renders live content (assert on a value only the database can supply) rather than the fixture.

### As reported by Agent F (P0) — Whole AI Legends UI serves a bundled fixture that forces attributed real-person names on, bypassing the PRL_LEGEND_NAMING opt-in

**Location.** `apps/web/src/lib/legends-data.ts:47-52 (LEGEND_API_PATHS) vs apps/api/src/app.ts:55 (API_PREFIX='/api/v1'); consequence at apps/web/src/fixtures/legends.ts:651 (namingMode:'attributed') and :186-202 (attributedDisclosure)`

**Problem.** Every Legends request the web app makes omits the /v1 segment, 404s, and falls through to the bundled fixture. That fixture deliberately ships namingMode:'attributed' with displayName '<real name> (modelled style)' and attributed:true. So the production web app, with PRL_LEGEND_NAMING unset and the API healthy, renders six real people's names as profile identities on every page load — bypassing the single guardrail the naming design exists to enforce (AI-LEGENDS.md §2: 'the safe mode is the default, because the mode you get by not thinking about it should be the safe one'; §12 L11 makes attributed naming a deployer decision with legal consequences). Riding along: only 8 of the 12 profiles are shown (the fixture's own comment says 'Eight of the twelve profiles the server ships'), so the required roster is not delivered, and the compare / hand-review pages render sample analyses.

**Reproduction.**

```
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/legends/profiles
404
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/api/v1/legends/profiles
200
$ curl -s http://127.0.0.1:3000/legends > /tmp/legpage.html
$ grep -o "profile service is not reachable[^\\\"]*" /tmp/legpage.html | head -1
profile service is not reachable, so this page is rendering the bundled sample profiles. The trait values and the disclaimers are real; treat nothing here as a live figure. (That lesson, quiz or scenario does not exist.)
$ for n in Hellmuth Ivey Seidel Chan Deeb Glaser Brunson Negreanu; do echo "$n: $(grep -o $n /tmp/legpage.html | wc -l)"; done
Hellmuth: 2
Ivey: 2
Seidel: 2
Chan: 4
Deeb: 2
Glaser: 2
Brunson: 0
Negreanu: 0
$ grep -o 'modelled style' /tmp/legpage.html | wc -l
14
$ for p in /legends /legends/compare /legends/hand-review /legends/patient-technician; do curl -s http://127.0.0.1:3000$p | grep -c "not reachable"; done
1
1
1
1
```

**Evidence.** apps/web/src/fixtures/legends.ts:650-654 —
  export const LEGEND_PROFILES_FIXTURE: LegendProfilesResponse = {
    namingMode: 'attributed',
    profiles: LEGEND_PROFILE_FIXTURES,
and :191-201 —
  displayName: `${input.attributedName} (modelled style)`,
  ...
  attributed: true,
The trailing '(That lesson, quiz or scenario does not exist.)' in the fallback banner is the API's own 404 body, so the request reached the API and was rejected on the path. apps/web/next.config.ts contains no rewrite, and API_ORIGIN defaults to http://localhost:3001 where the API is running. Same root cause also breaks /api/session and /api/content/* (the /learn index renders its fallback too).

**Recommended fix.** Add the version segment to LEGEND_API_PATHS, learn-data.ts and api.ts's '/api/session' (the real session route is /api/v1/auth/session), preferably by importing one API_PREFIX constant from @prl/contracts so the two cannot drift again. Independently and regardless of that fix: change LEGEND_PROFILES_FIXTURE to namingMode:'archetype' and use archetypeDisclosure for every profile — an offline render path must never be able to display an attributed name, because the whole point of the env var is that a human decides. If the attributed rendering needs a render-check, keep it in a test-only fixture the app cannot reach.

**Missing test.** (a) A test asserting every path in LEGEND_API_PATHS / LEARN_API_PATHS / api.ts resolves to a route the Fastify app actually registers (enumerate app.printRoutes(), or assert the shared prefix constant is used). (b) A test asserting no fixture reachable from a production code path has namingMode==='attributed' or disclosure.attributed===true. (c) A smoke check that no page renders a non-null fallbackReason while the API is up.

---

## R2 — P0 — /play is a static fixture: no hand can be played in a browser, and the action buttons are inert

**Raised by:** Agent A, Agent G (2 independent reviewers)

**Lead assessment.** The server side is real: hub, router, table, bots, per-recipient redaction,
reconnect, idempotency — and 357 API tests over it. None of it is reachable from the
product, because `apps/web` contains no socket client at all (`grep -c 'new WebSocket'`
= 0). `TableStage.onAct` is optional and `/play` does not pass it.

This is the "no fake multiplayer, no placeholder UI" guardrail violated directly, and it
is the single largest piece of remaining work — a feature to build, not a line to correct.
Agent E's P1 (nothing in the repo opens a real socket) is the same hole seen from the test
side and is tracked separately as R9, because writing the client does not by itself create
the end-to-end test that proves it works.

### As reported by Agent A (P0) — /play never opens a WebSocket — guided bot play and private multiplayer are not wired to the server

**Location.** `apps/web/src/app/play/page.tsx; apps/web/src/components/TableStage.tsx:115; apps/web/src/fixtures/table.ts`

**Problem.** There is no WebSocket client anywhere in apps/web. /play renders entirely from src/fixtures/table.ts with ?state= selecting one of four static fixtures. TableStage's onAct is optional and the page does not supply it, so submitting a decision disables the controls and states that nothing was sent. The server side (ws/hub.ts, ws/router.ts, rooms/table.ts, rooms/bots.ts) is complete and well tested but unreachable from the product.

**Reproduction.**

```
$ grep -rn "new WebSocket" apps/web/src | wc -l
0

$ grep -rIn "WebSocket|EventSource|socket" apps/web/src --include=*.ts --include=*.tsx | grep -vi "websocket contract|WebSocket that will feed|the WebSocket"
apps/web/src/app/play/page.tsx:12:  * screen renders from `src/fixtures/table.ts` … the day the socket
apps/web/src/app/play/page.tsx:131: * "no server" means in code; this is the same fact stated for a reader. It goes when the socket
apps/web/src/fixtures/table.ts:10:  * socket lands, the only change is where the object comes from.
(only prose in comments — no socket constructor)
```

**Evidence.** apps/web/src/app/play/page.tsx:11-14: "The API and the WebSocket that will feed this route are being built in parallel with it. So the screen renders from `src/fixtures/table.ts`, typed against the real contract, and the day the socket lands the only change is where the object comes from." That day has not come. The required features "guided bot play", "private invite-only multiplayer", "an immersive table" and "a premium Coach panel" are static fixtures in the shipped app.

**Recommended fix.** Implement the socket client: connect to ws://<api>/api/v1/ws, send hello with PROTOCOL_VERSION, render from the WsEvent state frames, and wire TableStage's onAct to a submitAction frame carrying a client-generated actionId plus the expectedSequence from the current view. The contract already exists in packages/contracts/src/ws-protocol.ts and is exercised by apps/api/test/ws-router.test.ts.

**Missing test.** An end-to-end test that opens a real socket against a running API, plays one hand to completion against a bot and asserts the client rendered the server's terminal state; plus a unit test asserting /play supplies onAct (i.e. the live path, not the fixture path, is the default).

### As reported by Agent G (P0) — /play is a static fixture: no hand can be played in a browser, and the Fold/Call/Raise buttons are enabled but inert

**Location.** `apps/web/src/app/play/page.tsx:11-23 and apps/web/src/fixtures/table.ts:6`

**Problem.** The flagship journey is unimplemented in the UI. The page's own header says 'The API and the WebSocket that will feed this route are being built in parallel with it. So the screen renders from src/fixtures/table.ts'. The page has zero references to the API client, and the action buttons are rendered enabled while doing nothing. The requirements explicitly ban placeholder/fake play.

**Reproduction.**

```
Clean production build served on :3200 with a working private API on :3101, inspected in Chrome:
  Page text, last line of /play:  'FIXTURE STATES — NO SERVER IS CONNECTED'
  Buttons found (none disabled):
    {"text":"Fold0 units","disabled":false}
    {"text":"Call35 units","disabled":false}
    {"text":"Raise to 7070 units","disabled":false}
  Clicking Call:
    before    { url: 'http://localhost:3200/play', pot: '100' }
    afterCall { url: 'http://localhost:3200/play', pot: '100' }   // no change
  The API request log shows no request at all from the click.
```

**Evidence.** apps/web/src/app/play/page.tsx contains no reference to @/lib/api (grep for apiFetch|@/lib/api returns 0 hits) and two imports from @/fixtures/table.ts. The server side does work — pnpm run test:smoke passes 37 checks against the live API including guest sessions, room creation, invite-only joins and hand-history isolation — so this is a front-end gap, not a missing engine.

**Recommended fix.** Wire /play to POST /api/v1/rooms, POST /api/v1/rooms/:roomId/sit and the WebSocket at /api/v1/ws using the frames in @prl/contracts. Until then the action buttons must be disabled with a visible reason: an enabled button that silently does nothing is worse than a disabled one.

**Missing test.** An end-to-end test that creates a guest session, sits at a bot table and completes one hand through the UI, asserting the pot changes; plus a CI rule that fails a production build if a route under apps/web/src/app imports from src/fixtures/.

---

## R3 — P0 — The declared release gate `pnpm run security:audit` fails deterministically, so CI is red on every push

**Raised by:** Agent C, Agent E, Agent G (3 independent reviewers)

**Unresolved severity disagreement, recorded not averaged.** Agents E
and G both rate this **P0**; Agent C rates the same defect **P1**.

C's reasoning is that the underlying supply-chain *policy* is sound and enforced by
`pnpm-workspace.yaml`, so nothing is actually insecure — only the checking script is
broken. E and G reason that a release gate which cannot run is not a gate, that CI is red
on every push, and that `pnpm run verify` aborts before reaching the tests, so the
failure also suppresses everything downstream of it.

**My adjudication: P0**, siding with E and G. Not because C's analysis is wrong — it is
correct that the policy itself holds — but because the brief makes supply-chain
verification release-blocking, and a gate that fails deterministically is
indistinguishable from a gate that is absent. The specific aggravating fact is that
`security:audit` sits early in `pnpm run verify`, so its failure means the documented
verification command never runs lint, typecheck, build or tests at all. C's point survives
in the fix: this is a defect in the checker, not in the policy, so the fix must not relax
any policy to make the check pass.

### As reported by Agent E (P0) — pnpm run security:audit fails deterministically; the whole CI pipeline is blocked and pnpm run verify never runs the tests

**Location.** `scripts/supply-chain/policy-check.mjs:59-62 and :95-106 (interaction with pnpm-workspace.yaml:31 verifyDepsBeforeRun: error)`

**Problem.** The documented release gate fails 100% of the time. policy-check.mjs asks pnpm for its effective config via `pnpm config list --json`, but when it is itself invoked from a pnpm script, pnpm has already injected pnpm_config_verify_deps_before_run=false into the environment to suppress re-verification on nested invocations. The gate reads pnpm's own suppression flag as the repository's policy and declares the policy absent. Because the CI `supply-chain` job is what lint, typecheck, test, exhaustive, build and a11y all `needs:`, every CI job is blocked. And `pnpm run verify` (security:audit && lint && typecheck && build && test) dies at step 1, so the composite release command never runs a single test.

**Reproduction.**

```
$ pnpm run security:audit\n  ✗ policy setting not in effect: verifyDepsBeforeRun = false\n      required because: refuse to run against a stale node_modules\n  ✗ policy-in-effect — 1 failure(s)\nSummary\n  ✗ FAIL  policy in effect\n  ✓ pass  source encoding hygiene ... ✓ pass  SBOM generation\n1 gate(s) failed — this is release-blocking.\n[ELIFECYCLE] Command failed with exit code 1\n\nRan twice, exit 1 both times. Also fails identically with the documented `pnpm run security:audit -- --offline`.\n\n$ pnpm run verify\n1 gate(s) failed — this is release-blocking.\n[ELIFECYCLE] Command failed with exit code 1   <- never reaches lint/typecheck/build/test
```

**Evidence.** The same script passes when NOT run through pnpm:\n$ node scripts/supply-chain/policy-check.mjs\n  · 12 policy settings asserted against pnpm's effective config\n  ✓ policy-in-effect — pass\n\nThe injected variable and the value the gate therefore reads:\n$ pnpm exec env | grep -i verify\npnpm_config_verify_deps_before_run=false\n(from inside a pnpm-spawned process, the same call the gate makes)\nverifyDepsBeforeRun = false\n(from an ordinary shell)\n$ pnpm config get verifyDepsBeforeRun\nerror\n\nThe policy IS correctly configured (pnpm-workspace.yaml:31 -> `verifyDepsBeforeRun: error`) and the gate's own predicate would accept it (`expect: (v) => v === 'error' || v === true`). This is a detection bug in the gate, not a policy hole — but it is release-blocking by the project's own stated rule and it stops CI dead.

**Recommended fix.** Read the setting from a source pnpm does not override for nested runs: either strip pnpm_config_* keys from the child environment before the execFileSync, or resolve the value from pnpm-workspace.yaml plus ~/.config/pnpm/rc directly and keep the `pnpm config` read only for settings pnpm does not self-suppress. Add a comment naming the keys pnpm injects into script environments, or this will regress.

**Missing test.** There is no test anywhere for scripts/** (verified: no test file references scripts/). Add a test for policy-check.mjs that runs it (i) from a bare environment and (ii) with pnpm_config_verify_deps_before_run=false pre-set, asserting the verdict is identical — the exact discrimination this defect turns on. Each of the eight gates should also have a fixture proving it fails on a crafted violation and passes on the real lockfile; the eight gates that decide whether the product ships are themselves entirely unverified.

### As reported by Agent G (P0) — The declared release gate `pnpm run security:audit` fails in a clean room and in this repo, so CI is red on every push

**Location.** `scripts/supply-chain/policy-check.mjs:93-101 (execFileSync('pnpm', ['config','list','--json'])), invoked via package.json security:policy/security:audit and .github/workflows/ci.yml:117, supply-chain.yml:94`

**Problem.** pnpm injects pnpm_config_verify_deps_before_run=false into the environment of any script it runs, to stop nested re-verification. The gate spawns `pnpm config list --json` from inside that environment, the child reports verifyDepsBeforeRun = false, and the gate fails. The setting is correctly configured in pnpm-workspace.yaml; the gate is measuring its own wrapper. Because ci.yml's lint/typecheck/test/exhaustive/build/a11y jobs all declare `needs: supply-chain`, no CI job ever runs to completion.

**Reproduction.**

```
$ pnpm run security:audit      # clean room
▸ policy in effect
  · 12 policy settings asserted against pnpm's effective config
  ✗ policy setting not in effect: verifyDepsBeforeRun = false
      required because: refuse to run against a stale node_modules
  ✗ policy-in-effect — 1 failure(s)
...
Summary
  ✗ FAIL  policy in effect
  ✓ pass  (the other seven gates)
1 gate(s) failed — this is release-blocking.
exit 1

$ pnpm run security:policy ; echo $?    # in this repo
  ✗ policy setting not in effect: verifyDepsBeforeRun = false
1
```

**Evidence.** The same gate passes when it is not wrapped by pnpm, and the injected variable is visible:
  $ node scripts/supply-chain/policy-check.mjs
    · 12 policy settings asserted against pnpm's effective config
    ✓ policy-in-effect — pass        (exit 0)
  $ pnpm config list --json | grep verifyDeps      # plain shell
  verifyDepsBeforeRun = "error"
  $ pnpm exec env | grep -i verify_deps
  pnpm_config_verify_deps_before_run=false
Both the clean room and this repo return exit 1 for security:audit and security:policy.

**Recommended fix.** Strip pnpm_config_* / npm_config_* from the child environment before spawning (execFileSync(..., { env: filtered })), or read pnpm's effective config without a subprocess. Whichever is chosen, assert the gate from inside a `pnpm run` wrapper, because that is how it is invoked in README, RUNBOOK and both workflows.

**Missing test.** A test for policy-check.mjs that runs it through `pnpm run` (not `node`) and asserts it passes on a correctly configured workspace and fails when a policy key is moved into .npmrc.

### As reported by Agent C (P1) — `pnpm run security:audit` fails: the documented release gate and both CI workflows are red

**Location.** `scripts/supply-chain/policy-check.mjs:92-106 (the nested `execFileSync('pnpm', ['config','list','--json'])`), assertion at :58-62. Consumed by package.json `security:audit`, .github/workflows/ci.yml:118, .github/workflows/supply-chain.yml:95.`

**Problem.** The policy gate asks pnpm for its effective configuration by shelling out to `pnpm config list --json`. When the gate is itself launched through `pnpm run`, pnpm injects `pnpm_config_verify_deps_before_run=false` into the child environment (its own mechanism for not re-verifying deps in a nested invocation). The nested `pnpm config list` inherits that variable and reports `false`. The gate asserts `'error' || true`, fails, and the audit exits 1 printing 'this is release-blocking'. The underlying policy is genuinely fine — pnpm-workspace.yaml:38 really does say `verifyDepsBeforeRun: error`, and read outside a `pnpm run` child pnpm reports it correctly. So this is a false failure in the gate, not a supply-chain hole, but the release gate has never been green through its documented entry point and CI cannot pass.

**Reproduction.**

```
$ pnpm run security:audit
  ✗ policy setting not in effect: verifyDepsBeforeRun = false
      required because: refuse to run against a stale node_modules
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

Same code, same lockfile, same machine, invoked directly:
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

**Evidence.** The injected variable and the divergence it causes:

$ pnpm exec env | grep -i verify_deps
pnpm_config_verify_deps_before_run=false

$ pnpm config get verifyDepsBeforeRun      # normal shell
error

$ pnpm run security:policy                 # inside a `pnpm run` child
  ✗ policy setting not in effect: verifyDepsBeforeRun = false

$ node scripts/supply-chain/policy-check.mjs
  ✓ policy-in-effect — pass

The policy the gate fails to see, pnpm-workspace.yaml:38: `verifyDepsBeforeRun: error`.

The gate is NOT broken in the dangerous direction — it still catches a genuinely unsafe config, so the fix must not delete the assertion:
$ pnpm_config_ignore_scripts=false pnpm_config_minimum_release_age=0 pnpm_config_verify_store_integrity=false node scripts/supply-chain/policy-check.mjs
  ✗ policy setting not in effect: ignoreScripts = false
  ✗ policy setting not in effect: minimumReleaseAge = 0
  ✗ policy setting not in effect: verifyStoreIntegrity = false

(`npm_config_`-prefixed vars do NOT override the workspace file — only pnpm's own `pnpm_config_` injection does, which is why this manifests for exactly one setting.)

**Recommended fix.** In policy-check.mjs, strip the inherited override before spawning: pass an `env` to execFileSync with `pnpm_config_verify_deps_before_run` removed (and, defensively, any `pnpm_config_*`/`npm_config_*` key matching a REQUIRED name). That preserves the 'ask pnpm for the effective value' design, which is the gate's whole point. Alternative: assert `verifyDepsBeforeRun` against the parsed pnpm-workspace.yaml specifically, with a comment on why this one key cannot be read from the effective config, keeping the other 11 on the effective-config path. Do NOT relax the assertion to accept `false` and do not drop the key.

**Missing test.** A test that runs the policy gate THROUGH `pnpm run` and asserts exit 0 — i.e. asserts the gate is correct via its documented entry point, not only when called directly (every current check invokes it the way that happens to work): assert.equal(spawnSync('pnpm', ['run','security:policy']).status, 0). Plus a companion test asserting the gate still fails when a required setting is genuinely wrong, so the fix cannot be 'stop asserting'.

---

## R4 — P0 — Coach computes the EV of a raise as though it were an opening bet, so raise EV is overstated and its advice is frequently wrong

**Raised by:** Agent B, Agent F (2 independent reviewers)

**Lead assessment.** Three findings, one root cause (`coach.ts:249-251`), but they are NOT one fix
and I am keeping them in one cluster only because the same line is wrong in all three: the
code treats a raise's total `to` as if the amount already on the table were not there.

The consequences are separable and each must be verified separately:
  (a) the EV arithmetic for every raise candidate is overstated (B, P0);
  (b) the suggested size is below the engine's own minimum legal raise in **21 of 34
      shipped scenarios**, so the Coach recommends actions the server would reject
      (B, P1);
  (c) the published `sizeRange` therefore contains sizes the engine rejects (F, P1).

**This is the most serious defect in the review and the reason the aggregate verdict is
not merely "unfinished".** Everything else is something that does not work. This is
something that works and teaches the wrong answer, in an app whose entire purpose is
teaching decision quality. It sits behind a Coach panel that presents itself as
authoritative, and a learner has no way to detect it. Agent B rates it P0 on those grounds
and I agree without reservation.

### As reported by Agent B (P0) — Coach computes the EV of a raise as if it were an opening bet, so every raise EV is overstated and the recommendation is frequently wrong

**Location.** `packages/poker-math/src/coach.ts:241-256 (buildCandidates) — `betSize: option.amount` at line 243, `to: input.toCall === 0 ? option.amount : input.toCall + option.amount` at line 250`

**Problem.** For an aggressive candidate the Coach calls evOfBet({pot, betSize: option.amount, ...}). evOfBet models hero risking `b` into `pot` — correct for a bet, wrong for a raise. Raising by R while facing C to call risks C+R, the opponent adds R, and the final pot is pot+(C+R)+R, so the honest expression is f*pot + (1-f)*[e*(pot+C+2R) - (C+R)]. The Coach never charges hero the C, so every raise EV is overstated by exactly (1-f)*C*(1-e) — always upward, growing with the size of the bet faced and as hero's equity falls, i.e. most wrong exactly where a learner most needs it right. Pure bets (toCall=0) are exactly correct, which localises the defect to the raise path.

**Reproduction.**

```
Live API with the provided servers. POST /api/v1/math/coach with {"heroCards":"7c2d","board":"AhKdQs","street":"flop","opponents":["22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo"],"pot":400,"toCall":300,"heroStack":2000,"opponentStacks":[2000],"bigBlind":10} (session cookie + x-csrf-token + Origin: http://localhost:3000). Hero holds 7-2 offsuit on A-K-Q, equity 5.10%, break-even 42.86%. Response:
  fold   to=-     cost=0     ev=      0.000
  call   to=300   cost=300   ev=   -264.307
  raise  to=433   cost=133   ev=     75.624    <-- correct: -109.433
  raise  to=566   cost=266   ev=     -2.010    <-- correct: -187.067
  raise  to=2000  cost=1700  ev=   -839.053    <-- correct: -1024.110
SUGGESTION: {"action":"raise","sizeRange":{"min":433,"max":2000},"confidence":"reasonable","reason":"raise has the highest expected value against the stated range, by 75.6 chips over the next-best action."}
Overstatement = 0.65*300*(1-0.051) = 185.06, exactly as the formula predicts.

Then GET /api/v1/content/scenarios/:id for all 36 shipped scenarios and compare each report's own candidate EVs with the corrected formula at the same pot/toCall/equity:
  LIVE API: scenarios with toCall>0 and a raise candidate: 34
  raise EVs overstated in: 33
  grading verdict / recommended action changes once corrected: 4
    -> ['fl-top-pair-weak-kicker-river', 'fl-gutshot-facing-turn-bet', 'fl-overcards-dirty-outs', 'rk-pricing-a-river-bluff-raise']
  fl-top-pair-weak-kicker-river   pot=140 toCall=45  eq=0.0%  coachBest=19.1  trueBest=0.0  coachAct=raise trueAct=fold  foldGraded=False foldTruth=True
  rk-pricing-a-river-bluff-raise  pot=600 toCall=120 eq=0.0%  coachBest=80.0  trueBest=2.0  coachAct=raise
  rk-the-fold-that-feels-wrong    pot=900 toCall=400 eq=16.7% coachBest=343.2 trueBest=126.5 coachAct=raise
The recommended action is `raise` in 34 of 34, including two spots where hero is drawing dead (0.0% equity).

Control experiment (same helper, toCall=0) shows the model is exact when it really is a bet:
  bet 65  coach 117.522  correct 117.522  error 0.000
  bet 130 coach 111.881  correct 111.881  error 0.000
  bet 875 coach  47.224  correct  47.224  error 0.000
```

**Evidence.** packages/poker-math/src/coach.ts:241-256 —
  const bet = evOfBet({
    pot: input.pot,
    betSize: option.amount,      // <-- the raise INCREMENT only; input.toCall is never charged
    foldProbability: foldEquity,
    equityWhenCalled: heroEquity,
    callerCanRaise: true,
  });
  candidates.push({
    action: input.toCall === 0 ? 'bet' : 'raise',
    to: input.toCall === 0 ? option.amount : input.toCall + option.amount,
    cost: option.amount,         // <-- reported cost omits it too

evOfBet is correct and correctly documented; the Coach is using it for a spot it does not describe. Its own doc says: "`pot` is what is in the middle BEFORE the action ... Set f = 0 and what is left is `e x (pot + 2b) - b`, which is precisely `EV(call)` for someone facing a bet of `b` into a pot of `pot + b`."

The derivation string shown to the learner gives it away — labelled EV(bet) and claiming a risk of 133 when hero risks 433: "EV(bet) = f x pot + (1 - f) x [ e x (pot + 2b) - b ] = 0.35 x 400 + 0.65 x [ 0.051 x (400 + 2 x 133) - 133 ] = 140 + (-64.38) = 75.62 chips. Risks 133 to win 400."

Grading impact: consistencyOf (apps/api/src/routes/content.ts:734) judges a fold defensible only when bestOverall(report).ev <= margin (one big blind). The inflated raise EV pushes bestOverall over the margin, so in the 4 scenarios above a learner who correctly folds is told the fold is "not consistent with this analysis", while raising with 0% equity is told it is consistent. This flows through POST /content/scenarios/:id/attempt and the two decision-kind quiz questions.

The same wrong figures are baked into apps/web/src/fixtures/review.ts:506 and rendered on the shipped /review/[handId] page (ev: 117.522 for "raise to 130" at toCall: 65; correct value 93.576).

**Recommended fix.** Charge hero the call. Add a raise-aware function to ev.ts: evOfRaise({pot, toCall, raiseBy, foldProbability, equityWhenCalled}) with risk = toCall + raiseBy and calledBranch = e*(pot + risk + raiseBy) - risk, returning f*pot + (1-f)*calledBranch with terms and a derivation that says EV(raise) and states the true risk. Set cost = toCall + raiseBy. Take hero's actual committedThisStreet as a Coach input so `to` can be computed as committedThisStreet + toCall + raiseBy (see the separate P1 on illegal raise sizes). Regenerate apps/web/src/fixtures/review.ts afterwards.

**Missing test.** Numeric assertions against values derived outside buildCoachReport: (1) for pot 400, toCall 300, raiseBy 133, f 0.35, e 0.051 assert the raise EV is -109.43 +/- 0.01, with the arithmetic written out in the test body; (2) an invariant that every raise candidate has cost === toCall + increment and ev <= evOfBet({pot, betSize: candidate.cost}).ev — a raise can never beat a bet of the same total risk into the same pot; (3) a monotonicity test that holding everything else fixed and increasing toCall must make every raise EV FALL (today it does not move at all) — this alone catches the bug; (4) a 'never recommend aggression while drawing dead' test at equity === 0 using fl-top-pair-weak-kicker-river and rk-pricing-a-river-bluff-raise as fixtures. Also fix the existing test 'the price drives the decision: the same draw flips from raise to fold as the bet grows', which uses flushDrawVsSet({pot:100,toCall:400,heroStack:400}) where maxBet = heroStack - toCall = 0, so no raise candidate is produced at all (candidates are exactly ["fold","call"]) — it passes for a reason unrelated to its name.

### As reported by Agent B (P1) — Coach's suggested raise size is below the engine's own minimum legal raise in 21 of 34 shipped scenarios

**Location.** `packages/poker-math/src/coach.ts:250 (`to: input.toCall + option.amount`) and coach.ts:290,332-333 (sizeRange)`

**Problem.** `to` on a raise candidate is meant to be the total street commitment — that is the semantics the engine's validateAction uses when comparing `to` against minTo/maxTo. The Coach computes to = toCall + amount, which implies hero's existing street commitment is to - cost = toCall. That is true only by coincidence. In the normal case (hero has nothing in this street and faces a bet) hero's commitment is 0 and the minimum legal raise is at least 2 * toCall, so toCall + amount is below the minimum for every small rung on the ladder. CoachSuggestion.sizeRange.min is the smallest of these, so the app's headline advice names a size the server will reject with a BettingRuleError.

**Reproduction.**

```
Engine check against a real HandState (opponent bet 300, hero 0 committed):
  engine minimum raise TO facing a 300 bet with 0 committed = 600
  Coach suggested raise to = 433  -> LEGAL? false
  legalActions raise bounds: {"type":"raise","minTo":600,"maxTo":2000,"costAtMin":600,"allInAtMax":true,...}

Across the shipped Scenario Lab, read from the live API (GET /api/v1/content/scenarios/:id):
  suggested raise size BELOW the engine's minimum legal raise: 21 of 34
    eq-flush-draw-turn-overbet             suggests raise to     360, minimum legal at least     480 (facing 240)
    eq-rule-of-four-big-draw-flop          suggests raise to     246, minimum legal at least     340 (facing 170)
    eq-set-on-connected-flop-jam           suggests raise to     230, minimum legal at least     300 (facing 150)
    rk-counting-the-combos-that-beat-you   suggests raise to     560, minimum legal at least     960 (facing 480)
    rk-nine-big-blinds-call-or-fold        suggests raise to    9066, minimum legal at least   12800 (facing 6400)
    rk-when-survival-outweighs-chip-ev     suggests raise to   24000, minimum legal at least   44000 (facing 22000)
    ... 21 rows total
```

**Evidence.** packages/poker-math/src/coach.ts:250 —
  to: input.toCall === 0 ? option.amount : input.toCall + option.amount,
  cost: option.amount,
CoachInput (coach.ts:54-75) has no field for hero's existing street commitment, so the correct `to` is not computable from the Coach's inputs today. The existing test 'every candidate bet amount is a whole number of chips' checks Number.isInteger(candidate.to) — it verifies the type of the number, never its legality. The engine's minimumRaiseTo and legalActions are themselves correct (I verified the increment rule: over a bet of 20, a raise to 100 makes the next minimum 180, and a raise to 179 is rejected).

**Recommended fix.** Add heroCommittedThisStreet: number and minimumRaiseTo: number to CoachInput (the caller — apps/api/src/calc/parse.ts and coachTaskFor — has both from the engine state), then compute to = heroCommittedThisStreet + toCall + raiseBy, set cost = toCall + raiseBy, and drop or clamp ladder rungs whose `to` falls below minimumRaiseTo.

**Missing test.** A cross-package test asserting every aggressive candidate the Coach returns is accepted by the engine: build a real HandState, call buildCoachReport from it, then for each candidate call validateAction(state, seat, { type: candidate.action, to: candidate.to }) and assert it does not throw. Run it over all 36 shipped scenarios.

### As reported by Agent F (P1) — Coach publishes raise sizes the engine rejects, and prints one as its suggested size range

**Location.** `packages/poker-math/src/coach.ts:249-251 (to: input.toCall + option.amount); CoachInput at :54-76 carries no committedThisStreet and buildCandidates applies no minimum-raise floor. Rendered at packages/ui/src/components/CoachPanel.tsx:452 and apps/web/src/components/PostHandComparison.tsx:263`

**Problem.** The engine's Action.to is a seat's TOTAL commitment for the street. The Coach computes to = amountToCall + betSize, omitting whatever hero already committed this street, and applies no min-raise floor. Both errors point the same way, so the Coach routinely publishes raise sizes below legalActions[].minTo — sizes the table refuses — and prints the smallest as the lower bound of CoachSuggestion.sizeRange ('Raise — 33 to 990'). cost is correct so the EV arithmetic is sound; it is the size label and the legality that are wrong. Downstream, candidateForAction (packages/poker-ai/src/commentary.ts:475-488) and candidateFor (apps/web/src/lib/consistency.ts:76-88) match the learner's action by nearest `to`, so a hand review silently pairs a legal raise with a mislabelled candidate.

**Reproduction.**

```
Heads-up, blinds 5/10, 1000 stacks. Button raises to 30; hero is the big blind with 10 already committed. Each Coach raise candidate handed to the engine's validateAction:

COACH view: potTotal=40 amountToCall=20 heroCommittedThisStreet=10
COACH engine legal raise: minTo=50 maxTo=1000
COACH raise candidates: to=33 cost=13 ev=34.01 | to=46 cost=26 ev=36.77 | to=990 cost=970 ev=237.21
COACH suggestion: raise sizeRange={"min":33,"max":990}
COACH engine verdict to=33: REJECTED (BettingRuleError: raise to 33 is below the minimum of 50)
COACH engine verdict to=46: REJECTED (BettingRuleError: raise to 46 is below the minimum of 50)
COACH engine verdict to=990: LEGAL
COACH rejected 2/3 of the Coach's raise sizes

Postflop, hero bets 20 and is raised to 80:
COACH2 potTotal=120 amountToCall=60 heroCommittedThisStreet=20 engine minTo=140 maxTo=990
COACH2 candidate raise to=100 cost=40 -> REJECTED (raise to 100 is below the minimum of 140)
COACH2 candidate raise to=140 cost=80 -> LEGAL
COACH2 candidate raise to=970 cost=910 -> LEGAL
```

**Evidence.** coach.ts:248-256 —
  candidates.push({
    action: input.toCall === 0 ? 'bet' : 'raise',
    to: input.toCall === 0 ? option.amount : input.toCall + option.amount,
    cost: option.amount,
CoachPanel.tsx:452 —
  {range === undefined ? '' : ` — ${formatUnits(range.min)} to ${formatUnits(range.max)}`}

**Recommended fix.** Add heroCommittedThisStreet and the engine's minRaiseTo (or the whole LegalAction set) to CoachInput; compute to = heroCommittedThisStreet + toCall + betSize; drop or clamp any ladder entry whose resulting `to` is below minRaiseTo; and omit sizeRange rather than publish a bound that is not offerable. The live call site (apps/api/src/ws/router.ts:620-654) already has the view and can supply all of it.

**Missing test.** For real engine states covering (i) preflop from the blinds, (ii) a re-raise after hero has bet, and (iii) a short stack whose only raise is an all-in below the minimum: build the Coach report from redactFor(state, seat) and assert every candidate.to for bet/raise passes validateAction(state, seat, {type, to}), and that suggestion.sizeRange.min and .max do too.

---

## R5 — P0 — A clean --frozen-lockfile install cannot build or typecheck the API; the working copy was repaired by six hand-made symlinks

**Raised by:** Agent G

**Lead assessment.** Found by one reviewer, and it invalidates a great deal of other evidence —
including some of mine. If the working tree only builds because someone created symlinks
by hand, then every green result obtained in this tree (mine included) was obtained in an
environment no clean checkout can reproduce. This is exactly the failure mode the
clean-room gate exists to catch, and it is why the final gate must run from a pristine
copy rather than here.

Related but separate: G's P1 that `pnpm run dev` serves HTTP 500 on most clean runs
because `@swc/helpers` is unreachable under `nodeLinker: isolated` (tracked as R12).
Same root cause — the isolated linker plus empty hoist patterns — different symptom and
different fix.

### As reported by Agent G (P0) — A clean --frozen-lockfile install cannot build or typecheck the API; the working copy is repaired by six hand-made symlinks

**Location.** `pnpm-workspace.yaml (nodeLinker: isolated, hoistPattern: [], publicHoistPattern: []) + apps/api/tsconfig.json:22-24 (a paths mapping exists for `ws` but not for `fastify`)`

**Problem.** Every @fastify/* plugin declares `fastify` only as a devDependency, never a peer. With nodeLinker: isolated and both hoist patterns empty, `fastify` is unreachable from inside those packages, so their own .d.ts files cannot resolve it; skipLibCheck: false (deliberate) makes that fatal, and the lost type augmentations produce ~20 further errors in first-party source including five TS7006 implicit-any. pnpm run build, pnpm run typecheck, pnpm run verify, docker build -f Dockerfile.api ., docker compose build api and CI's typecheck/build/a11y jobs all fail from a clean checkout.

**Reproduction.**

```
In a clean copy of the repo (no node_modules, no .env):
  $ pnpm install --frozen-lockfile   -> 'Lockfile is up to date', ok
  $ pnpm run build
  apps/api build: src/routes/auth.ts(457,15): error TS2339: Property 'setCookie' does not exist on type 'FastifyReply<...>'.
  apps/api build: src/ws/hub.ts(239,9): error TS2353: ... 'websocket' does not exist in type 'RouteShorthandOptions<...>'.
  apps/api build: ../../node_modules/.pnpm/@fastify+cookie@11.1.2/.../types/index.d.ts(3,36): error TS2307: Cannot find module 'fastify' or its corresponding type declarations.
  (same TS2307 for @fastify/csrf-protection, @fastify/helmet, @fastify/rate-limit, @fastify/websocket)
  [ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @prl/api build: `tsc -p tsconfig.json`  -> exit 2
  $ pnpm run typecheck -> exit 1 (adds TS7006 x5, 'csrfProtection does not exist', 'rateLimit does not exist')
  $ docker build -f Dockerfile.api .
  ERROR: failed to build: process "/bin/sh -c pnpm --filter \"@prl/api...\" run build" did not complete successfully: exit code: 2
```

**Evidence.** The same tsc succeeds in this repo because of symlinks no install created — note the 21:30 mtime against 19:55 for everything pnpm wrote:
  $ ls -la node_modules/.pnpm/@fastify+websocket@11.3.0/node_modules | grep fastify
  lrwxr-xr-x  1 terence  staff  41 17 Aug 21:30 fastify -> ../../fastify@5.11.3/node_modules/fastify
  lrwxr-xr-x  1 terence  staff  54 17 Aug 19:55 fastify-plugin -> ../../fastify-plugin@6.0.0/node_modules/fastify-plugin
The same hand-made `fastify` link exists in @fastify+cookie, @fastify+helmet, @fastify+rate-limit and @fastify+csrf-protection (which also gained a hand-made @fastify/cookie), all at 21:30. The clean-room tree has none. The lockfile is not stale: `pnpm install --no-frozen-lockfile` reports 'Lockfile is up to date' and yields a zero-line diff, and pnpm-lock.yaml:1046 records only duplexify/fastify-plugin/ws for @fastify/websocket@11.3.0.

**Recommended fix.** Solve it the way apps/api/tsconfig.json already solves the identical problem for `ws`: add `paths` entries mapping `fastify` (and `@fastify/cookie`) to the API's own node_modules, or add a narrow hoistPattern in pnpm-workspace.yaml. Then delete the six hand-made symlinks and prove the build from a scratch install — they are invisible to git, to the lockfile and to verifyDepsBeforeRun.

**Missing test.** A CI job that installs into an empty store (pnpm store prune && rm -rf node_modules && pnpm install --frozen-lockfile) and then runs pnpm run build and pnpm run typecheck, plus a container-build job.

---

## R6 — P0 — Neither container can start: the web runtime WORKDIR is wrong and the API compose environment omits the session secret and HOST

**Raised by:** Agent G

**Lead assessment.** Two distinct defects kept in one cluster because they share one verification:
`docker compose up` must bring the whole stack to healthy. Both are P0 because the
documented deployment path does not work at all, and G's P2 (no CI job builds an image or
runs compose) explains why neither was ever caught — tracked as R17.

### As reported by Agent G (P0) — The web container cannot start: the runtime stage's WORKDIR is /app, but `next start` needs /app/apps/web

**Location.** `Dockerfile.web:97-133 (runtime stage inherits WORKDIR /app from base at line 59; CMD is ["/app/apps/web/node_modules/.bin/next", "start"])`

**Problem.** `next start` resolves .next relative to the working directory, so it looks for /app/.next, which does not exist. The container exits 1 immediately and, under compose's `restart: unless-stopped`, crash-loops forever. The built image itself is fine.

**Reproduction.**

```
$ docker build -f Dockerfile.web -t prl-web-review:g .    # ok, 51s, exit 0
$ docker run --rm prl-web-review:g
▲ Next.js 16.3.0
✓ Ready in 77ms
✓ Running next.config took 7ms
Error: Could not find a production build in the '.next' directory. Try building your app with 'next build' before starting the production server.
$ docker ps -a --filter name=prl-web-g --format '{{.Status}}'
Exited (1) 20 seconds ago

Following the runbook's container instructions:
$ WEB_PORT=3300 docker compose up -d --no-deps web
$ docker compose ps --format '{{.Service}} {{.Status}}'
postgres Up 3 hours (healthy)
web      Restarting (1) 2 seconds ago
```

**Evidence.** The identical image with only -w added starts and is healthy, including the read-only root filesystem and both documented tmpfs mounts:
  $ docker run -d -w /app/apps/web --read-only --init --tmpfs /tmp:mode=1777,noexec,nosuid,size=64m --tmpfs /app/apps/web/.next/cache:mode=0700,uid=1000,gid=1000,size=256m -p 127.0.0.1:3211:3000 prl-web-review:g
  $ docker ps -a --format '{{.Status}}'  ->  Up 10 seconds (healthy)
  $ curl -o /dev/null -w %{http_code} http://127.0.0.1:3211/       -> 200
  $ curl -o /dev/null -w %{http_code} http://127.0.0.1:3211/learn  -> 200
The failing run logs '✓ Running next.config took 7ms' while the working run logs '✓ Running next.config.ts took 26ms' — from /app it never found the config file either. .next/BUILD_ID and .next/static are present in the image.

**Recommended fix.** Add `WORKDIR /app/apps/web` to Dockerfile.web's runtime stage (or set working_dir in compose).

**Missing test.** A CI job that builds both images, runs each container, and waits for its HEALTHCHECK to report healthy — the web healthcheck would have caught this the first time anything ran the container.

### As reported by Agent G (P0) — The API container refuses to boot: compose sets a variable nothing reads, omits the session secret, and omits HOST

**Location.** `docker-compose.yml:122-131 (api.environment) and Dockerfile.api:173-174 (runtime ENV sets NODE_ENV and PORT but no HOST)`

**Problem.** Three defects in one block. (1) PRL_ALLOWED_ORIGINS is set, but nothing in the repository reads it — the API reads PUBLIC_WEB_ORIGIN (config.ts:283); grep finds PRL_ALLOWED_ORIGINS only in docker-compose.yml itself. (2) SESSION_COOKIE_SECRET is never set while NODE_ENV=production is, which config correctly refuses. (3) HOST is never set and the default is 127.0.0.1 (config.ts:499), while .env.example:33-35 says 'In a container set 0.0.0.0'; Dockerfile.web sets HOSTNAME=0.0.0.0 for Next but Dockerfile.api has no equivalent. The HEALTHCHECK probes 127.0.0.1 inside the container, so the container would report healthy while being unreachable from the compose network and from the published port.

**Reproduction.**

```
$ docker compose config | sed -n '/^  api:/,/^  web:/p'
    environment:
      DATABASE_URL: postgres://poker:poker-dev-only@postgres:5432/poker_risk_lab
      NODE_ENV: production
      PORT: "3001"
      PRL_ALLOWED_ORIGINS: http://127.0.0.1:3000,http://localhost:3000

$ env -i PATH=$PATH DATABASE_URL='postgres://poker:poker-dev-only@postgres:5432/poker_risk_lab' NODE_ENV=production PORT=3001 PRL_ALLOWED_ORIGINS='http://127.0.0.1:3000,http://localhost:3000' node src/server.ts
Refusing to start: 2 configuration problems.
  - PUBLIC_WEB_ORIGIN is required in production (comma-separated allowlist)
  - SESSION_COOKIE_SECRET is required in production; generate one with `node -e "..."`
EXIT=78
```

**Evidence.** grep -rn 'PRL_ALLOWED_ORIGINS' over the repo (excluding node_modules) returns exactly one line: docker-compose.yml:131. With the two missing variables supplied, loadConfig still yields host = 127.0.0.1, port = 3001 — a container binding loopback is unreachable from outside its network namespace, while the HEALTHCHECK at Dockerfile.api:200-201 probes http://127.0.0.1:${PORT} and would pass.

**Recommended fix.** Rename the compose variable to PUBLIC_WEB_ORIGIN; require SESSION_COOKIE_SECRET from the environment with no default so a missing one fails loudly; set HOST: 0.0.0.0 for the api service (or in Dockerfile.api's runtime ENV next to PORT). Consider having the healthcheck probe the address actually bound, so 'healthy but unreachable' cannot happen.

**Missing test.** A compose smoke test in CI (docker compose up -d, wait for both services healthy, curl /api/v1/health on the published port and / on the web port), plus a config test asserting every variable named in docker-compose.yml is one loadConfig reads.

---

## R7 — P0 — The sticky decision panel covers the entire poker table at every common desktop viewport

**Raised by:** Agent D

**Lead assessment.** `play.css:474-478`. Pot, board, all six seats and the dealer button are
obscured. The brief's explicit instruction was "never sacrifice poker information for
aesthetics", and this is that instruction inverted: the decision panel hides the
information the decision is about. P0 on the frontend brief's own terms.

### As reported by Agent D (P0) — Sticky decision panel hides the entire poker table (pot, board, all six seats, dealer button) at every common desktop viewport

**Location.** `apps/web/src/styles/play.css:474-478`

**Problem.** At ≥900px `.prl-play__decision` becomes `position: sticky; inset-block-end: 0` with `z-index: var(--prl-z-sticky)` (100) and an opaque `--prl-surface-page` background, and it is 566px tall. Pinned to the bottom of a normal laptop viewport it completely covers the 520px-tall table field. On landing at /play (scroll 0 — the state every user starts in) the pot, board, all six seats and the dealer button are occluded. This violates §10's explicitly functional requirement that the pot, cards, price and equity be visible at the same time, and falsifies play.css §9's claim that "there is no viewport size at which the four figures fall off the screen" — the figure it loses is the pot.

**Reproduction.**

```
Computed geometry + document.elementFromPoint hit-testing at the seat centre, dark theme, /play:
1440x900:  decision{pos:sticky,bottom:0px,z:100,bg:rgb(11,13,17),top:334,h:566} field{top:375,h:520} seatCentre[206,728] -> FIELDSET.prl-sizer  seatCovered:TRUE
1440x1400: decision{top:834,h:566}  seatCentre[206,728] -> DD.prl-seat__stat-value  seatCovered:false
1920x1080: decision{top:514,h:566}  seatCentre[430,728] -> BUTTON.prl-preset  seatCovered:TRUE
1280x800:  decision{top:263,h:566}  seatCentre[179,726] -> SPAN.prl-action-btn__cost  seatCovered:TRUE

Occlusion vs scroll at 1440x900:
scrollY=0    pot occluded:true  board occluded:true  seatsUnoccluded 0/6
scrollY=300  pot occluded:false board occluded:true  seatsUnoccluded 3/6
scrollY=450  pot occluded:false board occluded:false seatsUnoccluded 4/6
At no scroll position are all six seats unoccluded.
```

**Evidence.** play.css:472-478 — the comment names the pot as the thing being protected and the rule is what hides it:
  /* Guarantee 1 and 2: the price and the pot cannot scroll away. */
  .prl-play__decision { position: sticky; z-index: var(--prl-z-sticky); inset-block-end: 0; }
Screenshot pair from the identical build/theme, differing only in viewport height: shots/play-1440x1400-TABLE-VISIBLE.png shows the full oval (six seats, dealer button on BTN, POT 100 UNITS, board Q♥ 7♥ 2♣, active seat marked three ways); shots/play-1440x900-TABLE-HIDDEN.png shows no table, no pot, no board, no phase spine. The table itself is correctly built and laid out — this is purely a stacking/height failure of the overlay above it. Tablet (834x1112) and mobile (390x844) are unaffected because the sticky rule starts at 900px.

**Recommended fix.** The decision block must not overlap the table. Cheapest first: (a) drop position:sticky and let it sit in its grid row, relying on the existing sticky HUD for the price; (b) keep it sticky but cap its height with max-block-size and make the table field's min-height account for the pinned height so the grid reserves that space; (c) collapse the sizer to a compact bar when pinned, expanding on focus. Whichever is chosen, the pinned height must be subtracted from the space the table may claim.

**Missing test.** A layout regression test that at 1280x800, 1440x900 and 1920x1080 asserts document.elementFromPoint() at the pot's centre and at each of the six seats' centres returns that element or a descendant. The §10 guarantee is stated in prose and enforced nowhere; a three-viewport hit-test would have failed the moment the sticky rule landed.

---

## R8 — P1 — Engine: positionLabels mislabels every seat at a 3+ handed table, and all-in run-outs are not run out

**Raised by:** Agent B

**Lead assessment.** Two independent engine defects from the adversarial rules reviewer, both real
poker-correctness errors rather than cosmetic ones.

`positionLabels` never emits SB or BB at three or more handed and reports the small blind
as the cutoff. Position is one of the syllabus items the app is required to teach, and the
lesson content leans on these labels, so this is teaching-incorrect as well as
display-incorrect.

The all-in defect is a rules violation: when one player still has chips and everyone else
is all-in, betting should be closed and the remaining streets dealt out. Instead the lone
chipped player is asked to act on every street and is offered a fold that forfeits a pot
they are already fully committed to. That is not a legal option in No-Limit Hold'em.

### As reported by Agent B (P1) — positionLabels mislabels every seat at a 3+ handed table; SB and BB are never emitted and the small blind is reported as the cutoff

**Location.** `packages/poker-engine/src/positions.ts:137 (inside positionLabels), root cause at positions.ts:42 (orderFrom)`

**Problem.** orderFrom is documented at positions.ts:36 as "Occupied seats ordered clockwise starting at `from` (exclusive)" but is not exclusive: the loop runs `for (let step = 1; step <= maxSeats; step++)` and at step === maxSeats the candidate is (from + maxSeats) % maxSeats === from, so `from` is ALWAYS the last element returned. Three callers rely on that inclusive behaviour and are correct (ante posting, hole-card deal order, seatOrderFromButton for odd chips). positionLabels does not: `const rest = orderFrom(bigBlindSeat, maxSeats, occupied).filter((seat) => seat !== buttonSeat)` is meant to be 'under the gun round to the cutoff' but wraps all the way round and so also contains the small blind and the big blind. The subsequent labels.set calls overwrite the correct SB and BB entries, and the name list runs out so trailing seats fall through to 'MP'.

**Reproduction.**

```
node -e "... positionLabels(btn, 6, occupied) ...":
  2-handed btn=0 SB=0 BB=1 -> [[0,"BTN/SB"],[1,"BB"]]                                (correct)
  3-handed btn=0 SB=1 BB=2 -> [[0,"BTN"],[1,"UTG"],[2,"CO"]]                         (SB->UTG, BB->CO)
  4-handed btn=0 SB=1 BB=2 -> [[0,"BTN"],[1,"HJ"],[2,"CO"],[3,"UTG"]]
  5-handed btn=0 SB=1 BB=2 -> [[0,"BTN"],[1,"HJ"],[2,"CO"],[3,"UTG"],[4,"UTG+1"]]
  6-handed btn=0 SB=1 BB=2 -> [[0,"BTN"],[1,"CO"],[2,"MP"],[3,"UTG"],[4,"UTG+1"],[5,"HJ"]]
  6-handed btn=2 SB=3 BB=4 -> [[0,"UTG+1"],[1,"HJ"],[2,"BTN"],[3,"CO"],[4,"MP"],[5,"UTG"]]
  orderFrom(4,6,[0..5]) = [5,0,1,2,3,4]   <-- doc says "(exclusive)"; 4 is present

And through redactFor, the recipient-specific state every client receives (6-handed, button = seat 0):
  seat 0  position="BTN"   (button)
  seat 1  position="CO"
  seat 2  position="MP"
  seat 3  position="UTG"
  seat 4  position="UTG+1"
  seat 5  position="HJ"
  forced bets actually posted: [{"kind":"smallBlind","seat":1,...},{"kind":"bigBlind","seat":2,...}]
Seat 1 posts the small blind and is labelled CO. Seat 2 posts the big blind and is labelled MP.
```

**Evidence.** assignBlinds and every action-order function (firstToActPreflop, firstToActPostflop) are correct — I verified them on real dealt hands including gapped seating. Only the labels are wrong. Blast radius: packages/poker-engine/src/redact.ts:121 -> SeatView.position in the state sent to every client (the live table UI); apps/web/src/lib/scenario-view.ts:111 -> the Scenario Lab table; apps/web/src/lib/hand-replay.ts:439 -> Hand Review replay. Position is an explicitly required teaching topic, so this teaches something false wherever a seat label is rendered. The only existing test of the function, packages/poker-engine/test/betting.test.ts:74, checks positionLabels(0, 2, [0, 1]) — the single heads-up case that returns early before the broken code path.

**Recommended fix.** In positionLabels, exclude the blinds as well as the button: `const rest = orderFrom(bigBlindSeat, maxSeats, occupied).filter((seat) => seat !== buttonSeat && seat !== smallBlindSeat && seat !== bigBlindSeat);`. Separately, either fix orderFrom's doc comment to say it INCLUDES `from` as the final element, or add an explicit `inclusive` parameter — the current comment is actively misleading and is the root cause.

**Missing test.** A table-driven test asserting the COMPLETE label map for 2, 3, 4, 5 and 6 occupied seats at several button positions and at a table with gaps ([0, 2, 5]). Two invariants catch the whole class: (a) labels.get(assignBlinds(...).smallBlindSeat) === 'SB' (or 'BTN/SB' heads-up) and labels.get(bigBlindSeat) === 'BB' for every table size and button position; (b) every occupied seat gets exactly one label and no label appears twice.

### As reported by Agent B (P1) — All-in run-outs are not run out: the lone chipped player is asked to act on every street and offered a fold that forfeits an already-fully-committed pot

**Location.** `packages/poker-engine/src/betting.ts:124-137 (isBettingClosedForHand, specifically the withChips.length === 1 branch at lines 131-135) together with packages/poker-engine/src/machine.ts:423 (closeStreet)`

**Problem.** isBettingClosedForHand's branch for the commonest all-in shape — one player with chips against all-in opponents — is dead code. It returns `!owesAction(state, only) && only.committedThisStreet >= state.betLevel`, but it is only ever evaluated from advanceStreets, which runs AFTER closeStreet, and closeStreet resets every seat's lastActedAtBetLevel to null (machine.ts:423). owesAction returns true whenever lastActedAtBetLevel === null, so !owesAction(only) is always false at a street boundary and the function always returns false. advanceStreets therefore deals one street and stops, contradicting its own doc comment ("when no further betting is possible ... it runs the board out to the river and shows down in one pass"). The remaining player is then handed a full action set including fold and bet against opponents who have no chips. Folding there is not a legal action in poker — once the action is closed the cards are tabled and the board runs out — and it forfeits a pot hero has already paid for in full and cannot be raised out of.

**Reproduction.**

```
node -e with startHand: heads-up 1000 vs 200, button raises to 200, seat 1 calls all-in:
  after seat1 calls all-in: street= flop  toAct= 0  board= 3
  seat statuses [[0,"active",800],[1,"allIn",0]]
  isBettingClosedForHand = false
  LEGAL ACTIONS OFFERED TO THE LONE CHIPPED PLAYER ON THE FLOP:
  [{"type":"fold","note":"Legal, but checking costs nothing."},
   {"type":"check","costAtMin":0,...},
   {"type":"bet","minTo":20,"maxTo":800,"costAtMin":20,"allInAtMax":true,"note":"Open the betting."}]
    street flop asks seat 0 to act
    street turn asks seat 0 to act
    street river asks seat 0 to act
  needed 3 extra CHECK actions to finish an all-in run-out; final street complete

Consequence with a fixed deck so the outcome is unambiguous:
  AA vs KK all-in preflop, seat1 all-in for 200, seat0 covers. street= flop
  seat0 holds Ah Ad   seat1 holds Ks Kc
  --- seat0 FOLDS on the flop (an action real poker does not allow) ---
  final stacks [[0,800],[1,400]]
  net {"0":-200,"1":200}
  endedByFold true showdowns 0
  --- for comparison, checking it down ---
  final stacks [[0,1200],[1,0]] net {"0":200,"1":-200}

Milder instance of the same root cause: with the big blind all-in for less than the small blind, the small blind is offered {"type":"raise","minTo":30,"maxTo":500} — a raise nobody at the table can call.
```

**Evidence.** isBettingClosedForHand returning false in the trace above is the proof: the branch that exists to return true there cannot, because closeStreet has already nulled the field it tests. Correct behaviour is visible in the adjacent case — when NOBODY has chips, withChips.length === 0 returns true early and the board does run out in one pass (verified: 'everyone all-in preflop -> complete, board 5 cards' for stacks [100,200,300,400], [55,55,300,1000], [7,13,19,23] and [1,1000,1000,1000]). Note also endedByFold: true and showdowns: 0, so the hand is recorded in review as ended by a fold when it was an all-in, and no cards are revealed. Chips are conserved in every variant (505 in / 505 out; and 0 conservation failures across a 4,000-hand fuzz), so nothing is created or destroyed, and timeoutAction correctly checks rather than calls — the defect is the over-permissive action set plus the missing automatic run-out.

**Recommended fix.** Make the one-chipped-player branch independent of lastActedAtBetLevel — the question it asks is 'is anyone left who could call a bet?', which does not depend on whether the sole remaining player has acted this street: `if (withChips.length === 1) { const [only] = withChips; if (only === undefined) return true; return only.committedThisStreet >= state.betLevel; }`. Independently, legalActions should not offer bet/raise when no opponent has chips behind, and should not offer fold when toCall === 0 and betting is closed for the hand.

**Missing test.** (1) An all-in run-out test asserting ZERO further actions are required: heads-up, hero covers, opponent calls all-in; assert state.street === 'complete', board.length === 5 and result.showdowns.length === 2 immediately after the calling action, with no further applyAction calls. (2) assert.deepEqual(legalActions(state, lone), []) — or at minimum that the types include neither 'fold' nor 'bet' — for the state where one seat has chips and every opponent is all-in and covered. (3) A property test over the randomised fuzz harness asserting no hand ever reaches a state where seatsInHand >= 2, exactly one seat is active, and that seat is toAct with its commitment already at betLevel. (4) A regression test that AA vs KK all-in preflop always pays the aces, with no available action that changes it.

---

## R9 — P1 — Test-suite integrity: `pnpm run test` skips 56 database tests including six hidden-information guardrail tests, and nothing opens a real socket

**Raised by:** Agent E

**Lead assessment.** The most damaging finding in Agent E's report, and the reason so much passed
review internally. The six skipped tests are precisely the ones asserting the guardrail
the brief calls out by name — that one player can never receive another player's private
cards. A suite that silently omits its own most important assertions while exiting 0 is
worse than a suite that fails: it manufactures confidence.

Kept as one cluster because both halves are the same category of defect (the critical path
has no executing coverage) and both are verified the same way — by proving the tests now
run and now fail if the property is broken.

### As reported by Agent E (P1) — pnpm run test silently skips 56 database tests, including six that verify the hidden-information guardrail

**Location.** `package.json ("test": "pnpm run test:unit && pnpm run test:integration", "test:integration": "pnpm --filter @prl/api test") and apps/api/package.json ("test": "node --test --test-concurrency=1 'test/**/*.test.ts'") — neither passes --env-file-if-exists=../../.env, unlike every db:* script in the same file`

**Problem.** With no DATABASE_URL in the environment, four whole suites plus the database half of repositories.test.ts skip. The documented local command reports 357 green tests while exercising ZERO SQL, and pnpm run verify — the release command — inherits that. The suite reports success rather than telling you it degraded.

**Reproduction.**

```
$ pnpm run test\n﹣ GET /hands # DATABASE_URL is not set, so the hand routes cannot be exercised against a table\n﹣ GET /hands/:handId # DATABASE_URL is not set, ...\nskipping the API-level hidden-information route tests: DATABASE_URL is not set, ...\n﹣ GET /hands/:handId over HTTP # DATABASE_URL is not set, ...\nℹ tests 357   ℹ pass 356   ℹ fail 0   ℹ skipped 1\n\n$ (cd apps/api && DATABASE_URL='postgresql://poker:poker-dev-only@127.0.0.1:5432/poker_risk_lab' node --test --test-concurrency=1 'test/**/*.test.ts')\nℹ tests 414   ℹ pass 414   ℹ fail 0   ℹ skipped 0
```

**Evidence.** Diffing the two runs' test names, these are among the 56 that only run with a database — every one is a check on the release-blocking "hidden cards and deck order never leak" guardrail at the HTTP/DB layer:\n  serves each player their own cards and never the other's\n  sends no deck, no cursor and no salt over the wire\n  never puts a hole card in a list row\n  has no column for the deck or the salts, and this proves it\n  returns hole cards only for the viewer own seat\n  opens a seat cards to everyone once it has shown down, and not before\nThe rest cover invite-code digests, seat contention, table-full rejection, keyset pagination, repository-level actionId idempotency, double-settle refusal, session revocation and sliding expiry, OIDC attempt single-consumption, and audit-log redaction. .github/workflows/ci.yml DOES set DATABASE_URL for the test job, so CI covers these; the documented developer and release commands do not.

**Recommended fix.** Add --env-file-if-exists=../../.env to @prl/api's test script (matching its dev script, which already has it). Make the degradation loud: print a banner at the end of the api run — 'WARNING: N database suites were skipped; this run proves nothing about SQL' — and add a test:integration:strict that exits non-zero when DATABASE_URL is unset, used by pnpm run verify.

**Missing test.** A meta-assertion in the api suite: when DATABASE_URL IS set, assert skipReason === null for every guard, so a future refactor that leaves a guard permanently true (a typo in the env var name, say) fails instead of quietly skipping forever.

### As reported by Agent E (P1) — Nothing in the repo opens a real WebSocket; the core multiplayer journey has no working automated coverage

**Location.** `apps/api/src/ws/hub.ts:180-296 (createWsHub) — registered by apps/api/src/routes/index.ts:50, instantiated by no test; apps/api/test/ws-router.test.ts drives WsRouter with a recorder sink`

**Problem.** Every WebSocket test exercises either the router with a fake sink or two pure functions (evaluateUpgrade, compileFrameValidator). The plugin that turns a real HTTP upgrade into a live connection is never registered in a test, so none of this is covered: the heartbeat loop and terminate() of a socket that missed two pings (hub.ts:214-224) — the mechanism that stops a half-open connection holding a seat's turn open; the per-session socket counter bySession (hub.ts:201, :268, :286-289) increment on open / decrement on close / delete at zero, a leak in which locks a user out after reconnects; toBytes (hub.ts:297-300) i.e. a fragmented Buffer[] frame; and the real ws upgrade path with a cookie-borne session plus onClose teardown. The socket-cap test only feeds socketsForSession to a pure function, so the accounting that produces that number is untested. Combined with the broken load test (P1-1) and a smoke test that never opens a socket, the product's central journey — join a table, sit, play a hand, reconnect — has zero working automated coverage.

**Reproduction.**

```
$ grep -rn "createWsHub|wsHub" apps/api/test/*.test.ts\n(no output)\n\n$ grep -rn "from 'ws'|new WebSocket" --include='*.ts' --include='*.mjs' apps packages scripts | grep -v node_modules\nscripts/load-test.mjs:491:      const socket = new WebSocket(this.wsUrl(), {\napps/api/src/ws/hub.ts:10: * ##  handshake. Page script also cannot set a header on `new WebSocket()`, ##\napps/api/src/plugins/security.ts:615:   * at all: browser script cannot set a header on a `new WebSocket()` handshake\n\n$ grep -c "WebSocket" scripts/smoke-test.mjs\n0\n\n$ pnpm run test:smoke  ->  37 check(s) passed, none of them over a socket
```

**Evidence.** The only real-WebSocket client in the whole repository is scripts/load-test.mjs:491, and that script fails on its first HTTP request (P1-1). apps/api/test/wiring.test.ts:105 asserts `{ method: 'GET', url: '/api/v1/ws' }` is registered on the assembled app but never connects. The cap test asserts only over a pure function: `evaluateUpgrade({ origin: ALLOWED_ORIGIN, userId: 'usr_a', socketsForSession: WS_LIMITS.maxSocketsPerSession })` (ws-router.test.ts:275-283) — socketsForSession is supplied by the test, never derived by the hub.

**Recommended fix.** Add an integration test that starts the assembled app on an ephemeral port, obtains a session cookie, and connects with `ws` (already a devDependency of @prl/api). Cover: successful handshake and welcome; the socket-cap counter across open -> close -> open; a fragmented Buffer[] frame; a socket that stops answering pings being terminated after two misses; and a drop mid-hand followed by a reconnect that receives the current view.

**Missing test.** As above, plus two sockets for one session (below the cap) both receiving recipient-specific state, and an upgrade refused when the cookie is absent — currently asserted only through the pure evaluateUpgrade rather than through a real handshake.

---

## R10 — P1 — Fabricated statistics presented to the learner as measured observations

**Raised by:** Agent D, Agent F (2 independent reviewers)

**Lead assessment.** The profile page states "Measured over 128 hands of your own play" over numbers
that come from a hard-coded fixture and describe no play at all. This is the
fabrication guardrail — the brief forbids inventing figures and requires that sampled
values be labelled as sampled with their uncertainty. Presenting a constant as a
measurement of the reader's own play is the most misleading form that can take.

Bundled with D's finding that only 8 of 12 profiles ship (requirement: 11) because both are
consequences of the fixture layer standing in for the service, and both are verified by the
same check: the Legends surface must be driven by the API and must not assert measurement
it does not have.

### As reported by Agent F (P1) — Live profile page presents invented statistics as 'Measured over 128 hands of your own play'

**Location.** `apps/web/src/fixtures/legends.ts:714-725 (PATIENT_TECHNICIAN_OBSERVED) via learnFromFixture (:728-739), rendered by apps/web/src/app/legends/[profileId]/page.tsx:145-152 (ObservedTable)`

**Problem.** Because the fixture path is always taken (see the P0), one profile carries a fabricated ProfileObservedStats object (128 hands, VPIP 0.27, PFR 0.22, 3-bet 0.07, aggression 0.61, bluff 0.31, showdown 0.24, fold-to-bet 0.58, mean size 0.62, half-width 0.08). ObservedTable prints its own sentence asserting provenance the data does not have. A page-level 'bundled sample data' banner exists elsewhere on the page, but the table's own note contradicts it, and ObservedTable never receives the LegendData.source discriminator so it cannot qualify the sentence.

**Reproduction.**

```
$ curl -s http://127.0.0.1:3000/legends/patient-technician | grep -o "Measured over [^<]\{0,120\}"
Measured over 128 hands of your own play, not declared by the profile. Every figure below carries the same sampling interval of 8.0 points, and several of the differences between profiles are narrower than that — w…
$ curl -s http://127.0.0.1:3000/legends/patient-technician | grep -c "bundled sample data"
1
```

**Evidence.** page.tsx:148-150 —
  <p className="prl-legend-observed__note">
    {`Measured over ${pluralise(observed.handsObserved, 'hand')} of your own play, not declared by the profile. …`}
  </p>
This is a product whose own lessons say 'a figure whose assumptions you cannot read is a figure you cannot check'; inventing a session is the one thing this panel must not do.

**Recommended fix.** Remove PATIENT_TECHNICIAN_OBSERVED from the reachable fixture (observed: null for every fixture profile), or thread `source` into ObservedTable and name the sample as illustrative when source === 'fixture'. The first is safer.

**Missing test.** A render test asserting that when loadLearnFromProfile returns source:'fixture', no rendered string contains 'of your own play'; plus a static assertion that no reachable fixture supplies a non-null observed.

### As reported by Agent D (P1) — AI Legends ships 8 of 12 profiles behind a permanent "service not reachable" notice; requirement is 11

**Location.** `apps/web/src/fixtures/legends.ts (8 profiles) vs packages/poker-ai/src/profiles.ts (12)`

**Problem.** The requirement names 11 opponent profiles. poker-ai defines 12 archetypes and the live API returns all 12, but the web fixture contains 8 and (because of P0-1) the fixture is always what renders. The shipped Legends experience is therefore 8 profiles plus a standing "the profile service is not reachable" banner in a deployment where the service is running and healthy, and the four absent profiles' detail routes render the 404 page. The UI also contradicts itself: the home metric band and footer both say twelve ("The twelve opponent profiles, as trait vectors").

**Reproduction.**

```
$ for d in educational realistic expert; do curl -s "http://127.0.0.1:3010/legends?difficulty=$d" | grep -oE 'href="/legends/[a-z0-9-]+\?difficulty' | sort -u | wc -l; done
difficulty=educational -> 8 profile cards
difficulty=realistic   -> 8 profile cards
difficulty=expert      -> 8 profile cards
(same 8 ids every time: adaptive-exploiter calling-station disciplined-specialist fundamentals-coach patient-technician reading-pressure-specialist vocal-aggressor volume-grinder)

$ curl -s http://127.0.0.1:3001/api/v1/legends/profiles | grep -oE '"archetypeName":"[^"]*"' | sort -u | wc -l
12
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3010/legends/old-school-pressure  -> renders h1="Page not found"
```

**Evidence.** grep -oE "id: '[a-z-]+'" apps/web/src/fixtures/legends.ts yields 8 profile ids plus the 3 difficulty ids. Rendered page probe: cardCount: 8, fallbackNotice: ["These profiles are bundled sample data", "The profile service is not reachable, so this page is rendering the bundled sample profiles..."]. Missing from the UI entirely: old-school-pressure, mixed-game-generalist, foundational-reader, range-narrator.

**Recommended fix.** Fix P0-1 so live data is used, AND bring the fixture to all 12 profiles so the fallback is not itself a requirement violation.

**Missing test.** Assert LEGEND_PROFILES_FIXTURE.profiles.length === PROFILES.length (fixture vs @prl/poker-ai), plus a render test asserting the /legends listing renders one card per profile. The fixture is typed against @prl/contracts, which makes it the right shape — it was never asserted to be the right length.

---

## R11 — P1 — Two divergent implementations of `consistentWithAnalysis`: the learner sees one verdict and the database records another

**Raised by:** Agent A

### As reported by Agent A (P1) — consistentWithAnalysis is implemented twice with different tolerances; the learner sees one verdict and the database records the other

**Location.** `apps/api/src/routes/content.ts:131,740 (server) vs apps/web/src/lib/consistency.ts:50,116 (client); consumed at apps/web/src/components/ScenarioStage.tsx:187-188`

**Problem.** The server's margin scales with the stakes (1 big blind): `const CONSISTENCY_MARGIN_BIG_BLINDS = 1;` then `const margin = CONSISTENCY_MARGIN_BIG_BLINDS * Math.max(1, bigBlind);`. The client's is a flat 5 units regardless: `export const CONSISTENCY_TOLERANCE_UNITS = 5;` then `consistent: gapUnits !== null && gapUnits <= CONSISTENCY_TOLERANCE_UNITS`. They disagree in both directions. Worse, ScenarioStage always judges locally and never reads ScenarioAttemptResponse.consistentWithAnalysis, so the verdict shown is the client's while the verdict persisted to scenario_attempts.matched_expected is the server's.

**Reproduction.**

```
By inspection of the two constants, both reachable today. At bigBlind=2 the server margin is 2 units and the client's is 5: an action 4 units off the best-valued row is INCONSISTENT to the server and CONSISTENT to the learner. At bigBlind=10 the server allows 10 and the client 5: an action 7 units off is CONSISTENT to the server and INCONSISTENT to the learner.

$ grep -n "CONSISTENCY_TOLERANCE_UNITS" apps/web/src/lib/consistency.ts
50:export const CONSISTENCY_TOLERANCE_UNITS = 5;
116:    consistent: gapUnits !== null && gapUnits <= CONSISTENCY_TOLERANCE_UNITS,
$ grep -n "CONSISTENCY_MARGIN_BIG_BLINDS" apps/api/src/routes/content.ts
131:const CONSISTENCY_MARGIN_BIG_BLINDS = 1;
740:  const margin = CONSISTENCY_MARGIN_BIG_BLINDS * Math.max(1, bigBlind);
```

**Evidence.** ScenarioStage.tsx:187-188 shows the server answer is never consulted: `? judgeConsistency(analysis, committed.action) : judgeConsistency(analysis, committed.action, committed.to);`. consistency.ts's own header argues "Two copies of a rule about what counts as consistent would eventually be two different rules" — which is exactly what happened, across the package boundary rather than within it. The product can tell a learner their decision was consistent and record the opposite.

**Recommended fix.** One rule, one place. Move the tolerance into @prl/poker-math (or @prl/contracts, which both sides already depend on) as a pure function of the report and the big blind, and have both content.ts and consistency.ts call it. Then have ScenarioStage prefer the server's consistentWithAnalysis when a live response is available, using the shared function only as the offline fallback.

**Missing test.** A shared-fixture test that runs the same CoachReport + action + big blind through the server's consistencyOf and the client's judgeConsistency and asserts the two `consistent` booleans are identical, across big blinds (1, 2, 10, 50) and EV gaps (0, 1, 3, 5, 11).

---

## R12 — P1 — `pnpm run dev` serves HTTP 500 on most clean runs; `NEXT_PUBLIC_API_ORIGIN` is undocumented and build-time-inlined

**Raised by:** Agent G

**Lead assessment.** Two deployment-blocking configuration defects. The second is subtle and
important: the variable is inlined at build time, so no deployment can point the web app at
its own API after the image is built, and compose sets a different variable
(`PRL_API_ORIGIN`) that nothing reads while claiming a proxy that does not exist.

### As reported by Agent G (P1) — `pnpm run dev` serves HTTP 500 on every route in most clean runs (@swc/helpers unreachable under nodeLinker: isolated)

**Location.** `pnpm-workspace.yaml (nodeLinker: isolated, hoistPattern: [], publicHoistPattern: []) interacting with Next 16 Turbopack dev externals; surfaces through apps/web/package.json `dev` and the root `dev` script`

**Problem.** Turbopack's dev externals chunk requires next/dist/compiled/next-server/app-page-turbo.runtime.dev.js resolved through the workspace symlink path (apps/web/node_modules/next/...) rather than the store realpath. From there @swc/helpers — a transitive dependency of next, present in the store and linked into next's own isolated directory — is not reachable, so every page render throws. README quick start and RUNBOOK §2 both end with `pnpm run dev`.

**Reproduction.**

```
Six runs, each after rm -rf .next, across two independent clean-room copies of the same install:
  cleanroom run0  -> HTTP 500 (Cannot find module '@swc/helpers/_/_interop_require_default')
  cleanroom retry -> HTTP 500 (req1 and req2 both 500, 4 swc errors logged)
  cleanroom run1  -> HTTP 200
  cleanroom run2  -> HTTP 500 (swc errors: 2)
  cr2 run0        -> HTTP 200
  cr2 run1        -> HTTP 500 (swc errors: 2)
  cr2 run2        -> HTTP 500 (swc errors: 2)
Log:
  ⨯ Error: Failed to load external module next/dist/compiled/next-server/app-page-turbo.runtime.dev.js: Error: Cannot find module '@swc/helpers/_/_interop_require_default'
  Require stack:
  - .../apps/web/node_modules/next/dist/client/lib/console.js
  - .../apps/web/.next/dev/server/chunks/ssr/[externals]__05yr04l._.js
   GET / 500 in 1305ms
```

**Evidence.** The resolution asymmetry, measured directly:
  FAIL  .../apps/web/node_modules/next/dist/client/lib/console.js -> MODULE_NOT_FOUND Cannot find module '@swc/helpers/_/_interop_require_default'
  OK    .../node_modules/.pnpm/next@16.3.0_.../node_modules/next/dist/client/lib/console.js -> .../@swc+helpers@0.5.15/node_modules/@swc/helpers/cjs/_interop_require_default.cjs
@swc/helpers@0.5.15 does export ./_/_interop_require_default (110 export keys, file present on disk), so this is purely a resolution-root problem. next build + next start are unaffected.

**Recommended fix.** Add @swc/helpers to apps/web's own dependencies, or add a narrow hoistPattern (e.g. ['@swc/helpers']) in pnpm-workspace.yaml. Document it next to the nodeLinker: isolated comment, since this is the second runtime consequence of that setting (see the fastify finding).

**Missing test.** A CI job that starts next dev, requests / and /learn and asserts 200, repeated (or with the cache cleared) enough times to catch a flaky resolution.

### As reported by Agent G (P1) — NEXT_PUBLIC_API_ORIGIN is undocumented and build-time-inlined, so no deployment can point the web app at its own API

**Location.** `apps/web/src/lib/api.ts:42; absent from .env.example and RUNBOOK §7; docker-compose.yml:163-172 sets PRL_API_ORIGIN instead and claims a proxy that does not exist`

**Problem.** This is the only variable that decides where a browser sends every API request. (1) It appears nowhere in the configuration documentation — I enumerated every process.env read in apps, packages and scripts and cross-checked against .env.example; this is the gap that matters. (2) NEXT_PUBLIC_* is inlined at build time, so setting it in the container environment has no effect; the image ships whatever the build saw (default http://localhost:3001). (3) The compose comment says 'the web app proxies /api/* to this origin rather than the browser calling a second host', but apps/web/next.config.ts has no rewrites (its header says 'Deliberately absent: ... any redirect') and API_ORIGIN is an absolute origin, so the stated __Host- + SameSite=Strict same-origin rationale does not hold in the shipped topology.

**Reproduction.**

```
$ NEXT_PUBLIC_API_ORIGIN=http://localhost:3101 node_modules/.bin/next build
$ grep -ro 'http://localhost:3101' .next/static | head -1
.next/static/chunks/15u1aolqncubd.js:http://localhost:3101      # baked into a client chunk

$ grep -rn 'PRL_API_ORIGIN' . | grep -v node_modules
docker-compose.yml:172
scripts/smoke-test.mjs:26
scripts/a11y-audit.mjs:1352
# nothing in apps/web
```

**Evidence.** apps/web/src/lib/api.ts:42 — `export const API_ORIGIN = process.env['NEXT_PUBLIC_API_ORIGIN'] ?? 'http://localhost:3001';` is the only process.env read in the entire web app. cat next.config.ts shows exactly three options (reactStrictMode, transpilePackages, images.unoptimized) and no rewrites.

**Recommended fix.** Decide the topology and make it real. Either add a rewrites proxy in next.config.ts so the browser only talks to the web origin (which is what the cookie design and the compose comment assume), or keep two origins, document NEXT_PUBLIC_API_ORIGIN in .env.example and RUNBOOK §7, pass it as a Docker build arg, and delete the misleading compose comment and the dead PRL_API_ORIGIN.

**Missing test.** A config test asserting that every variable in .env.example is read somewhere and every variable read by first-party code is in .env.example (with an explicit allowlist for NO_COLOR and similar).

---

## R13 — P1 — `pnpm run test:load` has never worked: three non-existent routes plus CSRF sent too late

**Raised by:** Agent E, Agent G (2 independent reviewers)

**Lead assessment.** Both reviewers independently. It measures nothing and always has. Its own header
is scrupulously honest about what a load number does not mean, which made it read as
trustworthy — an unusually good illustration that documentation quality is not evidence of
function.

### As reported by Agent E (P1) — pnpm run test:load has never worked: three wrong route constants plus CSRF sent too late. It measures nothing.

**Location.** `scripts/load-test.mjs:89-93 (ROUTES) and :421-437 (Session.createGuest)`

**Problem.** The load harness points at endpoints that do not exist and does not obtain a CSRF token before its first mutating request, so it dies on request one, every time. ROUTES has `guest: '/api/v1/session/guest'` (real: POST /api/v1/auth/guest, auth.ts:383), `session: '/api/v1/session'` (real: GET /api/v1/auth/session, auth.ts:400), and `joinRoom: (roomId) => '/api/v1/rooms/${roomId}/join'` (real: POST /api/v1/rooms/join with the invite code in the body, rooms.ts:279). createGuest() POSTs before this.csrfToken is set, and request() only attaches the header when a token is already held. Additionally the default `origin: 'http://127.0.0.1:3000'` (:108) does not match the shipped `PUBLIC_WEB_ORIGIN=http://localhost:3000`, and the allowlist is exact-string. Nothing in CI runs this script, and it is the only real-WebSocket client in the repo.

**Reproduction.**

```
$ pnpm run test:load\n  x table 0 failed: POST /api/v1/session/guest -> 403 forbidden: You do not have access to that.\n  guest sessions 0 | connections 0 established of 0 attempted | hands completed 0 of 5 | actions sent/applied 0 / 0\n  rate 100.000% of 2 operations\nFAIL - completed 0 of 5 hands; error rate 100.00% exceeds the 1.00% threshold\n\n$ node scripts/load-test.mjs --origin http://localhost:3000\n  x table 0 failed: POST /api/v1/session/guest -> 403 csrf_failed: That request could not be verified.\n\nThe wrong path never surfaces as a 404 because every unknown route answers content_not_found (apps/api/src/errors.ts:401):\n$ curl -s http://127.0.0.1:3001/nope\n{"error":{"code":"content_not_found","message":"That lesson, quiz or scenario does not exist."}}
```

**Evidence.** createGuest() at :421-431 —\n  async createGuest() {\n    const created = await this.request(ROUTES.guest, {   // this.csrfToken is still null here\n      method: 'POST', body: { displayName: this.name } });\n    // ... if a server ever stops returning the token there, fall back to a plain GET rather than\n    // sending no header and failing every later request with csrf_failed.\n    this.csrfToken = created?.csrfToken ?? null;\nThe comment anticipates the exact failure it causes. scripts/smoke-test.mjs:150-160 does it correctly (GET /api/v1/auth/session, setCsrf, then POST).\n\nProof the harness is otherwise sound — I copied it to scratch and changed exactly four things (three route constants + a GET ROUTES.session to seed the token):\n  guest sessions 3 | rooms created 1 | joins 2 | connections 3 established of 3 attempted\n  seats taken 3 | hands completed 5 of 5 | actions sent/applied 58 / 57\n  p50 0.3ms p90 0.6ms p99 1.7ms max 1.7ms n=57 | server messages/second 4522.7\n  Errors none, rate 0.000% of 70 operations — PASS\n\nSecond problem once it runs: at 24 sessions it trips the API's own rate limiter with no flag or documented override —\n$ node lt.mjs --tables 4 --seats 6 --hands 15\n  guest sessions 7 | Errors 4 rate_limited, 4 transport:table-failed | FAIL 0 of 60 hands\nThe word "rate" appears nowhere in load-test.mjs except an unrelated PRNG expression, and docs/RUNBOOK.md:71 lists the command as "configurable" with no caveat.

**Recommended fix.** Correct the three ROUTES entries; seed the CSRF token with a GET ROUTES.session at the top of createGuest(); default `origin` to match .env.example's PUBLIC_WEB_ORIGIN (http://localhost:3000) or resolve it from the environment; document that a multi-table run needs RATE_LIMIT_MAX raised and print the required value when a rate_limited error is seen.

**Missing test.** (a) A CI job that runs pnpm run test:load against a started API with a raised limit — the harness is the only real-socket coverage in the repo and nothing executes it. (b) A unit test asserting every path in load-test.mjs's ROUTES and in smoke-test.mjs is present in the assembled app, cross-checked against the route manifest apps/api/test/wiring.test.ts:71-107 already maintains. That test proves the server serves 25 routes; nothing proves the harnesses call those 25.

### As reported by Agent G (P1) — `pnpm run test:load` calls three routes that do not exist and cannot complete a single operation

**Location.** `scripts/load-test.mjs:88-93`

**Problem.** The harness's path table is wrong: '/api/v1/session/guest' (API: /api/v1/auth/guest), '/api/v1/session' (API: /api/v1/auth/session) and `/api/v1/rooms/${roomId}/join` (API: POST /api/v1/rooms/join with the id in the body). The POST to the non-existent guest path is rejected by the CSRF hook before routing, so the error reads csrf_failed rather than 404 and is easy to misread as a client problem. RUNBOOK:71 lists it as a supported command and its own header offers it as a CI gate, so the WebSocket live-table path has never been exercised by it.

**Reproduction.**

```
$ node scripts/load-test.mjs --base-url http://127.0.0.1:3101 --origin http://localhost:3200 --tables 1 --seats 3 --hands 3 --timeout 90
  health   ok  version 0.1.0
  x table 0 failed: POST /api/v1/session/guest -> 403 csrf_failed
Results
  guest sessions          0
  hands completed         0 of 3
  actions sent/applied    0 / 0
Errors
      1  csrf_failed
      1  transport:table-failed
  rate 100.000% of 2 operations
FAIL
  - completed 0 of 3 hands
  - error rate 100.00% exceeds the 1.00% threshold
EXIT=1
```

**Evidence.** scripts/load-test.mjs:88-93 declares guest: '/api/v1/session/guest', session: '/api/v1/session', joinRoom: (roomId) => `/api/v1/rooms/${roomId}/join`. The API's registered routes (apps/api/src/routes/auth.ts:382,400 and rooms.ts:278) are '/auth/guest', '/auth/session' and '/rooms/join', all under API_PREFIX. The harness printed 'health ok version 0.1.0' first, so the target was reachable and healthy.

**Recommended fix.** Import the paths from @prl/contracts rather than restating them (the same fix as the web-client path mismatch), and add the harness to CI with a tiny shape (--tables 1 --seats 2 --hands 1) so it cannot rot again.

**Missing test.** That CI job. A load harness that has never completed one hand is not a regression check.

---

## R14 — P1 — Graceful shutdown hangs the full grace period and exits 1 whenever a request is in flight

**Raised by:** Agent G

### As reported by Agent G (P1) — Graceful shutdown hangs the full 10 s grace and exits 1 whenever a request is in flight on a keep-alive socket; worker threads are still alive at the deadline

**Location.** `apps/api/src/server.ts:48-74 (shutdown), interacting with apps/api/src/plugins/security.ts:481 (forceCloseConnections: 'idle') and apps/api/src/routes/calc.ts:119 (the onClose hook that terminates worker threads)`

**Problem.** forceCloseConnections: 'idle' calls Node's closeIdleConnections() once, at close time. A socket that was mid-request at SIGTERM is not idle then and is never revisited, so app.close() never resolves, the onClose hook never runs, the four worker threads are never terminated, and the deadline fires with process.exit(1). Browsers always use keep-alive, so this is the normal deploy case. RUNBOOK.md:232 and ARCHITECTURE.md:277 both state the opposite — 'exits non-zero if the drain fails' — while here the drain succeeded (the in-flight request was answered 200) and the process still exited non-zero.

**Reproduction.**

```
One script, three modes, same Monte Carlo request (samples: 500000):
  mode=never    (pool never used)                exit={"code":0} after 6 ms     -> 'shutdown complete'
  mode=after    (pool used, request finished)    exit={"code":0} after 25 ms    -> 'shutdown complete'
  mode=inflight (SIGTERM 150 ms into request)    exit={"code":1} after 10022 ms -> {"level":50,"graceMs":10000,"msg":"shutdown timed out; exiting hard"}
The same in-flight test with a single header added:
  ### inflight WITH 'Connection: close' ###      exit={"code":0} after 57 ms    -> 'shutdown complete'
```

**Evidence.** Node diagnostic report taken with SIGUSR2 three seconds into the hang:
  report: report.20260818.010631.6905.0.001.json
    libuv handles that are referenced and active: timer, tcp, tcp
    worker threads in report: 4
      worker header threadId: 1 (async, active)
      worker header threadId: 2 (async, active)
      worker header threadId: 3 (async, active)
      worker header threadId: 4 (async, active)
    equity http status: 200 trials: 200000     <- the response WAS delivered
  exit code: 1

**Recommended fix.** After app.close() begins, keep dropping newly-idle sockets (repeat server.closeIdleConnections() on an interval, or drop keepAliveTimeout to ~0 for the duration of the shutdown), and close the worker pool on the shutdown path itself so a stuck app.close() cannot strand threads. Then align RUNBOOK §10 and ARCHITECTURE §14 with the actual behaviour.

**Missing test.** An integration test that starts the app, issues a request that is still running, sends SIGTERM, and asserts the in-flight response completes, the process exits 0, and it exits well inside SHUTDOWN_GRACE_MS — with a keep-alive client, because the Connection: close variant passes and hides the bug.

---

## R15 — P1 — Mobile nav focus trap leaks through the theme radio group, exposing hidden Fold/Call/Raise controls

**Raised by:** Agent D

**Lead assessment.** A WCAG 2.2 AA keyboard-navigation defect that also has a correctness edge: the
leaked controls are the betting actions, so a keyboard user can reach and operate table
controls that are visually hidden behind an open menu.

### As reported by Agent D (P1) — Mobile nav focus trap leaks through the theme radio group, exposing hidden Fold/Call/Raise controls

**Location.** `apps/web/src/components/MobileNav.tsx:174-188`

**Problem.** The sheet is role=dialog aria-modal=true and its Tab handler wraps from focusable[length-1], but the last focusables are the three theme radios and a radio group is a single tab stop at the *checked* radio. With the default theme ("Auto" = the first radio), Tab moves past the whole group; `active` is neither `last` nor outside the sheet, so the handler does nothing and focus lands outside the open sheet on the bet-sizing controls it is covering. The background is not inert either, so a keyboard user can focus and activate Fold/Call/Raise while looking at the navigation sheet — on a poker table an unseen "Raise" is a consequential action. Breaks §9 ("focus-trapped"), WCAG 2.4.3 and 2.4.11.

**Reproduction.**

```
390x844, /play, dark, default theme:
radios: [{i:0,value:"system",checked:true},{i:1,value:"light"},{i:2,value:"dark"}]
before Tab: {tag:"INPUT", value:"system", checked:true, inside:true}
after  Tab: {tag:"BUTTON", cls:"prl-preset", txt:"✓⅓ pot — 80 units total", inside:false, sheetDisplay:"flex"}
Tabbing 8x from the close button reaches .prl-preset at step 7 with insideSheet:false. Note what DOES work (my first read was wrong): Escape closes and returns focus — after Escape: {sheetDisplay:"none", trigger:"false", active:{cls:"prl-nav-trigger"}} — and the wrap works from the true last element: focus last radio -> Tab -> {cls:"prl-sheet__close", inside:true}. So the bug bites for "Auto" (the default) and "Light", not "Dark".
```

**Evidence.** MobileNav.tsx:174-188:
  const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const last = focusable[focusable.length - 1];
  ...
  if (!event.shiftKey && (active === last || !sheet.contains(active))) { event.preventDefault(); first.focus(); }
FOCUSABLE_SELECTOR collects all three radios, so `last` is the `dark` radio — an element that is only ever the tab stop if the user has selected Dark. Also verified document.querySelector('main').hasAttribute('inert') === false.

**Recommended fix.** Compute the *tabbable* set the way the browser does: group input[type=radio] by name and keep only the checked one (or the first if none checked). Smallest permanently-correct alternative: mark the page content `inert` while the sheet is open, which removes this whole bug class.

**Missing test.** A keyboard test that opens the sheet and presses Tab n+1 times for n tab stops, asserting sheet.contains(document.activeElement) after every press, with the theme radio left at its DEFAULT value. A test written after selecting "Dark" would pass while the default stays broken.

---

# Remaining findings (P2 / P3), not clustered

These are recorded in full so nothing is lost. Per the brief I fix the P2s that affect
correctness, security, UX or maintainability; the rest are declared as known limitations in
the final report.

## P2 (29)

### [A] Seven of the twelve Legend profiles cannot be persisted, and hand history cannot attribute a seat to a Legend at all

- **Location:** `db/migrations/0001_initial.sql:454-460 (room_members_bot_profile_allowed CHECK); apps/api/src/rooms/bots.ts:167-190; db/migrations/0001_initial.sql:640-667 (hand_seats has no profile column); packages/contracts/src/api-types.ts:407-416 (HandReviewSeat has no profile field)`
- **Problem:** room_members.bot_profile admits only 'nit','tight-aggressive','loose-aggressive','calling-station','maniac','unknown'. persistableProfile() reverse-maps the five profiles that have a legacy alias and returns 'unknown' for the other seven. hand_seats has no profile column and HandReviewSeat no profile field, so once the in-memory registry is gone (restart, or room closed) nothing records which Legend held a seat. The requirements demand post-hand comparison, "what can I learn from this player" and replay commentary, all of which need the profile.
- **Fix:** A migration widening the CHECK to the twelve real profile ids (retaining or migrating the five legacy names), a bot_profile column on hand_seats written at hand start, and a profile field on HandReviewSeat. Then delete persistableProfile.
- **Missing test:** A repository test that seats each of the twelve profiles in turn, reads the row back and asserts bot_profile equals the id seated; plus a hand-review test asserting the profile survives a discarded registry.

### [A] buildHandComparison has no server caller, so post-hand comparison is unreachable

- **Location:** `packages/poker-ai/src/comparison.ts:484 (exported via packages/poker-ai/src/index.ts:50); expected by apps/web/src/lib/legends-data.ts:51`
- **Problem:** The pure implementation exists and is heavily unit-tested, but no API route calls it, and no route produces the HandComparison contract type. The web client expects GET /api/legends/hands/:handId/comparison, which does not exist at any prefix. The API's only legends routes are /legends/profiles, /legends/profiles/:profileId, /legends/matches and /legends/compare.
- **Fix:** Add the route: load the hand, build per-decision analysis as review/build-review.ts already does, and call buildHandComparison. It also needs the Legends persistence gap fixed, since it must know which profile played the seat.
- **Missing test:** A route test asserting GET /api/v1/legends/hands/:handId/comparison returns a HandComparison for a hand the caller played and 404 for one they did not.

### [A] CI never runs test:smoke, db:verify, security:hygiene or design:contrast

- **Location:** `.github/workflows/ci.yml, .github/workflows/supply-chain.yml`
- **Problem:** Four scripts that exist as release gates appear in no workflow. db:verify asserts the LIVE schema security properties — the check that would catch a migration introducing a deck or salt column or over-broad prl_app privileges. test:smoke is the only end-to-end check of the API's 37 documented behaviours. Both pass today; neither is enforced.
- **Fix:** Add `pnpm run db:verify` to the test job after db:migrate, `security:hygiene` to the supply-chain job, `design:contrast` to lint, and a job that boots the API and runs test:smoke.
- **Missing test:** N/A — this finding is itself the missing test wiring.

### [C] Log redaction misses the actual secret field names on HandState (deckSalts emitted as raw bytes)

- **Location:** `apps/api/src/logging.ts:74-84 (EXPLICIT_SENSITIVE_KEYS) and :63-64 (SENSITIVE_KEY_PATTERN); REDACT_PATHS at :336. Secret field names declared at packages/poker-engine/src/types.ts:200-236.`
- **Problem:** The comment above EXPLICIT_SENSITIVE_KEYS states its purpose: 'The rest is hidden game state that the server authority rules say never leaves this process … A log line is an exit this project has to close explicitly.' The set contains `deck`, `salt`, `salts`, `deckorder`, `commitmentsalt`, `holecards` — but NOT the names those secrets actually have on HandState: `deckSalts`, `deckCursor`, `holeCardPositions`, `boardPositions`. SENSITIVE_KEY_PATTERN does not match them either, so the scrubber passes the 52 Merkle salts through in full. This is exactly the failure the file's own comment warns about for REDACT_PATHS ('the classic way a redact list looks complete and is not'): because `deck`, `salt` and `salts` ARE covered, the list reads as complete. Also uncovered: `codeVerifier`, `state`, `nonce` — the OIDC single-use credentials.
- **Fix:** Add `deckcursor`, `decksalts`, `holecardpositions`, `boardpositions`, `codeverifier`, `oidcstate`, `oidcnonce` to EXPLICIT_SENSITIVE_KEYS. Better: derive the game-state half of the list from the engine rather than restating it — export the secret key names from poker-engine beside the HandState declaration and import them in logging.ts — so a new secret field on HandState cannot be added without the redaction list following. That converts this from 'remember to update two files' to fail-closed.
- **Missing test:** A test asserting isSensitiveKey returns true for EVERY field name the engine declares secret, sourced from the engine rather than hard-coded in the test (today the logging tests assert on names the author already thought of — the same blind spot as the list). Plus a test that pushes a real HandState through scrubLogObject and asserts no 32-byte buffer and no card array survives.

### [C] Router-level errors bypass the ApiError envelope and reflect the request URL

- **Location:** `apps/api/src/errors.ts:222-229 (FASTIFY_CODE map; note the FST_ERR_BAD_URL entry at :228) and :419 (app.setErrorHandler). No `frameworkErrors` option is set in apps/api/src/plugins/security.ts:468-498 (securityServerOptions).`
- **Problem:** Two reachable paths return Fastify's raw internal error shape instead of the project's ApiError envelope: the internal `code`, the internal `message`, the caller's URL reflected back, and no `requestId`. This violates the project's own rule in docs/SECURITY.md §3 'Output': 'Never return an internal error message, stack trace or SQL fragment. Log the detail server-side, return internal_error with a request id.' It also makes the `FST_ERR_BAD_URL: 'invalid_request'` entry at errors.ts:228 dead code — it looks like the case is handled and it is not, because Fastify 5 raises router errors before a route context exists and serves them via `frameworkErrors`, which is never configured. Impact is bounded (application/json, so not an XSS vector, and a long path is not a secret) but a client parsing body.error.code gets the string 'Bad Request', body.error.message is undefined, and there is no request id to quote in a bug report.
- **Fix:** Set `frameworkErrors` in securityServerOptions (plugins/security.ts) to route router-level errors through the same apiErrorBody builder the rest of the API uses, mapping FST_ERR_MAX_PARAM_LENGTH and FST_ERR_BAD_URL to `invalid_request` (or a 414-appropriate code) and never echoing error.message. Add FST_ERR_MAX_PARAM_LENGTH to the FASTIFY_CODE map while there.
- **Missing test:** A test asserting EVERY reachable error response matches the ApiError schema, driven by a list of malformed requests that includes an over-long path parameter and an invalid percent-escape — rather than only errors that flow through setErrorHandler. The current suite's error tests all go through the route layer, which is why both of these were missed.

### [C] Impersonation guard bypassable by case and near-synonym (fix for prior defect #8 is incomplete)

- **Location:** `packages/poker-ai/src/labelling.ts:207-210 (named-person mental-state pattern) and :216-220 (gendered-pronoun pattern).`
- **Problem:** Defect #8 was reported as the guard missing 'Ivey senses weakness' (name before a mental-state verb) and 'He would raise here' (poker verb after `would`). Both specific strings are now caught, but the patch left the same class of gap open four ways. The named-person pattern is /\b\p{Lu}\p{L}+\s+(?:thinks?|feels?|believes?|senses?|intends?|wants?|remembers?)\b/u — no `i` flag (necessarily, since \p{Lu} requires an uppercase initial), so the VERB is also matched case-sensitively and the very sentence the patch was written for slips through when capitalised differently. The verb list omits `knows` and `suspects`. And the `would` + poker-verb case is covered only via the gendered-pronoun rule, so the same construction with a NAME instead of a pronoun is uncaught.
- **Fix:** Normalise before matching: case-fold for the verb and collapse runs of whitespace, while keeping the uppercase-initial requirement on the name (test \p{Lu} on the captured name token rather than relying on a case-sensitive whole regex). Add `knows`, `suspects`, `assumes`, `reckons`, `decides` to the verb list and re-run the package's own 4,955-string corpus to confirm zero false positives; if `knows` genuinely collides, exclude it by an anchored exception for 'Opponent read' rather than dropping the verb. Add a NAME + `would` + verb pattern so the name form of the 'He would raise here' case is covered, not only the pronoun form.
- **Missing test:** The existing test (packages/poker-ai/test/commentary.test.ts:342-355) asserts the guard rejects a fixed list of shapes. Make it a MUTATION test: for each string the guard is known to reject, assert it is still rejected after case-folding, upper-casing and whitespace expansion. That is the test that would have caught this patch being incomplete, and it generalises to future patterns.

### [E] packages/contracts ships an empty test/ directory; its suite reports tests 0 and exits 0

- **Location:** `packages/contracts/test/ (empty directory); packages/contracts/package.json -> "test": "node --test 'test/**/*.test.ts'"`
- **Problem:** The package holding every request/query/WebSocket JSON Schema, the wire protocol and the error catalogue has zero tests, and pnpm run test counts it as passing. A package whose suite runs nothing is indistinguishable in the output from one that passes.
- **Fix:** Either write the package's tests or delete the empty directory and the vacuous script. Worth testing directly: isErrorCode/isClientMessageType on hostile input; wsError's shape; every schema in ALL_SCHEMAS compiled against a matrix of accept/reject fixtures (the closed additionalProperties: false contract is load-bearing and only sampled today); each PATTERNS regex against a crafted near-miss.
- **Missing test:** A guard in test:unit that fails when any workspace package reports `tests 0`, so a zero-test package can never again look green.

### [E] The Math.random ban is enforced over 2 of 7 source trees, and a source comment claims a test that does not exist

- **Location:** `packages/poker-ai/src/policy.ts:254; guards at apps/api/test/server-randomness.test.ts:118 and packages/poker-engine/test/rng.test.ts:28-38`
- **Problem:** 'Cryptographic randomness ... never Math.random' is a release-blocking guardrail, but the source scans that enforce it cover only apps/api/src (recursive) and packages/poker-engine/src (one level, non-recursive). packages/poker-math/src — which contains monteCarloEquity and the variance simulations, precisely where reaching for Math.random() is tempting — plus packages/poker-ai/src, packages/ui/src, packages/content/src, packages/contracts/src and apps/web/src are unscanned. Worse, policy.ts:254 states a guarantee that is not tested.
- **Fix:** Promote the scanner in server-randomness.test.ts (which is well built — recurses, strips comments, and proves each detector fires) into a shared test helper and run it over every src/ tree in the monorepo including apps/web/src; make every walker recursive; and either add the assertion policy.ts claims or correct the comment.
- **Missing test:** packages/poker-ai/test/no-math-random.test.ts and equivalents for poker-math, ui, content, contracts and apps/web, each with the companion 'the scan would actually catch a violation' case that rng.test.ts:41-45 and server-randomness.test.ts:182-197 already model.

### [E] The strongest AI-Legends evidence in the repo is run by no script and no CI job (and neither are test:smoke or db:verify)

- **Location:** `packages/poker-ai/test/simulation/profile-differentiation.test.ts (835 lines, 18 tests, 113s); packages/poker-ai/package.json test:simulation; root package.json; .github/workflows/ci.yml`
- **Problem:** The package's `test` script globs test/*.test.ts (one level), so the simulation suite is excluded from test:unit. The root package.json has no test:simulation; test:all is `test && test:exhaustive && test:a11y`. CI has jobs supply-chain, lint, typecheck, test, exhaustive, build, a11y — none invokes it. docs/RUNBOOK.md's test table does not mention it. The only way to run it is `pnpm --filter @prl/poker-ai test:simulation`, which I had to construct. It is the only thing substantiating 'profiles differ measurably'. Also unrun by CI: pnpm run test:smoke and pnpm run db:verify, both of which pass and both of which assert things nothing else does.
- **Fix:** Add root test:simulation, test:smoke and db:verify scripts, include them in test:all, and add CI jobs for each (the simulation suite can be nightly if 2 minutes on every push is unwelcome, but it must be gated somewhere). List all three in docs/RUNBOOK.md's test table.
- **Missing test:** A guard asserting that every workspace package.json script whose name starts with `test` is reachable from a root script or a CI job — the defect class here is 'a good test nobody runs', and it recurs silently.

### [E] No test submits two actions for the same hand concurrently; enqueue is the only defence and it is untested

- **Location:** `apps/api/src/rooms/table.ts:325-332 (enqueue) and :583 (submitAction); apps/api/test/ws-router.test.ts:456 (dedupe) and :499 (stale sequence)`
- **Problem:** Every table mutation funnels through a promise-chain serialiser that no test exercises. The existing tests are strictly sequential: 'deduplicates a repeated actionId and applies it once' sends the duplicate after the first has resolved, and 'rejects a stale expectedSequence' likewise. Neither exercises the interleaving the serialisation exists to prevent. Also absent: two sockets on one session below the cap, and any test that the socket-cap counter decrements on close.
- **Fix:** Nothing to fix in the implementation — this is purely a missing test. The mechanism looks correct (work functions are synchronous, and a rejected work still advances the chain).
- **Missing test:** await Promise.all([table.submitAction(u, a1), table.submitAction(u, a2)]) with two distinct actionIds and the same expectedSequence, asserting exactly one resolves and the other rejects stale_action_sequence; the same with an identical actionId, asserting both resolve to the SAME memoised outcome and the state advanced once; and a third with the bot runner's timeout firing in the same tick as a player action.

### [E] The migration runner and schema verifier export nothing, so checksum drift, orphans and the advisory lock are untestable and untested

- **Location:** `apps/api/scripts/migrate.mjs (no export statements; MIGRATIONS_DIR hard-coded at :82); apps/api/scripts/verify-schema.mjs (likewise)`
- **Problem:** Every function in the migration runner is unreachable from a test: checksum-drift abort (planMigrations -> describeDrift, :357-392), orphan detection (:400), the advisory lock and its PRL_MIGRATE_LOCK_WAIT_MS timeout (:619), and the production seed guard (:520). MIGRATIONS_DIR is hard-coded so a test cannot point it at a fixture directory. This is the 'migration checksum mismatch' failure path named in the review brief, and it is not covered.
- **Fix:** Export planMigrations, checksumOf and describeDrift, and make MIGRATIONS_DIR overridable by parameter or env, so a test can point it at a fixture directory.
- **Missing test:** planMigrations against fixtures: a drifted checksum throws and names both digests; a ledger entry with no file is refused; pending files come back in filename order; the production guard refuses `seed` when NODE_ENV=production. Plus an integration test that migrates a throwaway database, mutates one migration file, and asserts the second run aborts having applied nothing.

### [E] Smoke-test checks that pass vacuously, an assertion that vanishes on failure, and warnings that cannot fail the run

- **Location:** `scripts/smoke-test.mjs:421-452 (section 8), :441, :450-451, :475-481, :37-49, :489-493`
- **Problem:** Three weaknesses in the script the brief describes as '36 checks end-to-end against a RUNNING api'. (1) Section 8's hidden-information checks are vacuous: the fixtures never play a hand, so both histories are empty — collectKeys over {hands: []} cannot contain deck/deckCursor/deckSalts/salts, and the isolation check compares two empty sets. (2) Line 441 is `if (bobHands.status === 200) { ... }` with no else bad(...), so a 500 from Bob's history yields no check at all. (3) warn() never fails the run (only `failures` triggers process.exit(1)), so a 500 on an unknown hand (:451) and 'no 429 after 60 guest creations' i.e. rate limiting silently gone (:481) both report a green run.
- **Fix:** Have the smoke test seat two guests and play one hand over the WebSocket before section 8, so the isolation checks have rows to be wrong about (this also closes part of the P1 WebSocket gap). Add the missing else bad(...) at :441. Promote the two security-relevant warns to bad, or make warn fail under a --strict flag that CI passes.
- **Missing test:** A smoke assertion that the fixture it depends on actually exists — assert aliceHands.length >= 1 before the no-leak scan — so an empty list is a failure rather than a free pass.

### [E] 54 hand-authored multiple-choice quiz answers have no verification of any kind

- **Location:** `packages/content/data/quizzes.json (17 quizzes, 80 questions); packages/content/test/scenarios.test.ts:317-373`
- **Problem:** The quiz set is { multipleChoice: 54, numeric: 24, decision: 2 }. The 24 numeric answers are computed at runtime from calculation.kind + field, and the existing test verifies the field is producible — good design, no hard-coded answer to be wrong. The 54 correctIndex values are authored by hand and nothing checks them. An off-by-one teaches a learner something false and marks a correct answer wrong, and no test would notice.
- **Fix:** For every question whose answer is derivable, assert it: parse the numbers out of the prompt and check the marked option against @prl/poker-math (the minimum-raise, side-pot and combo-count questions above are all machine-checkable). For the genuinely prose ones, at minimum assert the explanation mentions the marked option's substance, and add a reviewed-by field the test can check is present.
- **Missing test:** packages/content/test/quiz-answers.test.ts covering the derivable multiple-choice answers against the maths library, plus a completeness assertion that every question is either machine-checked or explicitly marked prose-reviewed.

### [F] ProfileStatsResponse — declared traits vs a large simulation, with divergences — is a dead contract

- **Location:** `packages/contracts/src/legends.ts:291-311`
- **Problem:** docs/AI-LEGENDS.md §9 presents this as a shipped honesty feature: 'ProfileStatsResponse.divergences surfaces the axes where a large simulation disagrees with the profile's declared trait. Not hidden, not smoothed: a model whose behaviour does not match its own card is a defect, and showing it is how it gets fixed.' §11 lists it again. Nothing implements it — no route produces it and nothing consumes it — so a learner is never shown any divergence, and there are three real ones to show (see the aggression/3-bet finding).
- **Fix:** Either implement the route and render it on the profile page, or delete the type and correct §9 and §11 of docs/AI-LEGENDS.md. Do not leave a documented honesty guardrail unimplemented.
- **Missing test:** A contract-coverage test asserting every exported response interface in @prl/contracts is either produced by a registered route or explicitly listed as intentionally unused with a reason.

### [F] Every profile is measurably less aggressive and less 3-bet-happy than its own card, the source comment states the bias backwards, and nothing in CI can fail on it

- **Location:** `packages/poker-ai/src/policy.ts:1190-1212 (aggression weight and the comment above it); packages/poker-ai/src/stats.ts:568-588 (the two tolerances); packages/poker-ai/test/simulation/profile-differentiation.test.ts:345-363 (reports but does not assert)`
- **Problem:** policy.ts states the direction of its own residual error and states it backwards: 'Everything after the odds is a reason to deviate from neutral, so the realised rate sits a little above the declared one ... That direction is intended.' Measured, the realised aggression frequency sits BELOW declared for all twelve profiles, by 0.026 to 0.188 — twelve of twelve in the same direction is p ~ 2.4e-4 under a sign test, a systematic bias, not scatter. Same for 3-bet frequency: twelve of twelve below declared. Two profiles breach their documented threeBetTendency tolerance and one breaches aggressionFrequency, and the suite prints them without asserting, so this cannot fail CI. The profile card and radar chart publish aggressionFrequency 0.52 for disciplined-specialist; the model plays 0.331.
- **Fix:** (a) Delete or invert the claim in policy.ts:1200-1203 — it is the reverse of the measurement and it is the sentence a maintainer would trust when the number drifts. (b) Assert on the remaining five axes in the simulation suite with the divergence list as the assertion value. Then either tighten the model, or widen the tolerance with a written reason, or ship ProfileStatsResponse so the learner sees the gap.
- **Missing test:** assert.deepEqual(divergences, []) in 'the remaining measurable axes are reported…', plus a directional test asserting the MEAN SIGNED error across profiles on each axis is inside a stated band, so a one-sided bias fails even when every individual profile is inside its own tolerance.

### [F] LearnFromProfileResponse.observed is hard-coded null, so the 'Observe' step of the documented educational loop does not exist

- **Location:** `apps/api/src/routes/rooms.ts:394-411, observed: null`
- **Problem:** docs/AI-LEGENDS.md §9 describes the six-step loop and promises for 'Observe': 'VPIP, PFR, 3-bet, aggression, bluff, showdown and fold-to-bet frequencies, average bet size as a pot fraction — with a confidenceHalfWidth, so 40 hands are not over-read', and calls LearnFromProfileResponse 'a complete probability lesson delivered by the product doing its own job'. The API never populates it. Nothing accumulates a per-learner SeatObservations; OpponentModel instances live on the bot seats, not the learner's.
- **Fix:** Either accumulate the learner's observed frequencies from the persisted hand history for that room (the counters and denominators already exist in packages/poker-ai/src/stats.ts) and fill the field, or correct §9 of AI-LEGENDS.md to state the Observe step is not implemented.
- **Missing test:** An API test that plays a legend match to a stated hand count and asserts observed.handsObserved equals it and confidenceHalfWidth equals 1.96 * 0.5 / sqrt(handsObserved).

### [F] No Math.random source scan exists for poker-ai, although the doc claims one is needed and warns about exactly this gap

- **Location:** `packages/poker-ai/ has no equivalent of packages/poker-engine/test/rng.test.ts:28-45; claimed in docs/AI-LEGENDS.md §6 and asserted as fact in packages/poker-ai/src/policy.ts:254`
- **Problem:** AI-LEGENDS.md §6: 'never from Math.random — which is banned in engine code and asserted absent by a source scan ... That scan is per-package by construction: it reads the src/ directory beside itself, so it covers @prl/poker-engine and @prl/poker-ai needs its own copy rather than inheriting it. Worth naming, because a scan pointed at the wrong package is worse than no scan — the repository looks guarded and is not.' The doc names the failure and then commits it. policy.ts:254 states 'Math.random is banned in this package and asserted absent'; nothing asserts it. No repo-wide scan exists either, so apps/api/src and apps/web/src are unguarded too. There is no live violation today, which is why this is P2 rather than P1 — what is missing is the guard against the regression, in the one package where a Math.random would destroy both determinism and the CSPRNG guardrail.
- **Fix:** Copy the engine's scan (including its self-test that the scan can fail, and its comment-stripping) into packages/poker-ai/test/, or better, promote it to a repo-level script in scripts/ that walks every */src directory and runs in CI. Then the doc's claim becomes true.
- **Missing test:** The scan itself, plus its own negative test: stripComments('const x = Math.random();') must still contain the token, and a comment mentioning it must not.

### [F] Three incompatible definitions of clean and dirty outs; the app reports '0 clean outs' in the lesson's own flagship example

- **Location:** `packages/poker-math/src/outs.ts:20-47 and :537-540 (threshold definitions) vs packages/content/data/lessons/foundations.json lesson 'counting-outs' ('Clean, dirty and imaginary' list + takeaway 2) vs packages/content/data/glossary.json entries clean-out, dirty-out and dirty-outs`
- **Problem:** Three definitions are in play. outs.ts: clean = equityAfter >= 0.90, dirty = >= 0.50 and < 0.90, neutral = < 0.50 ('not an out at all'). The lesson: 'A clean out MAKES YOU THE WINNER. When it lands you are ahead of what your opponent actually holds'; dirty = 'improves your opponent more, OR the hand it makes is second best, OR there is still another card to come for them to draw out'; imaginary = 'improves nothing that matters'. The glossary's dirty-out/dirty-outs entries repeat the 'improves your opponent more / second best' criteria. Definitions 2 and 3 call a card that leaves you BEHIND dirty; outs.ts calls it neutral and never lists it. Definitions 2 and 3 call a card that puts you ahead clean; outs.ts demotes it to dirty below 90%. OutsBreakdown on the wire has only clean/dirty/total, so the lesson's third category cannot be rendered from Coach output at all. Neither the lesson nor the glossary states the 0.90/0.50 thresholds; only the Coach's generated explanation does. There are also duplicate glossary ids dirty-out and dirty-outs with different wording (and clean-out has no plural twin).
- **Fix:** Pick one definition and propagate it. Cleanest: keep outs.ts's three buckets but rename them to what they measure (safe / ahead-but-vulnerable / not-an-out), expose all three on OutsBreakdown, and rewrite the lesson's list and both glossary entries to match — including stating the thresholds, since the lesson's own thesis is that a count without its assumption is 'a guess wearing a number'. Merge dirty-out and dirty-outs.
- **Missing test:** For every liveCalculation of kind 'outs' in the content set, run computeOuts and assert the returned cleanCount/dirtyCount are consistent with the surrounding prose — at minimum cleanCount > 0 wherever the caption or prose asserts that specific cards win. Plus a test that the glossary definition text and outs.ts's documented thresholds come from one source.

### [F] outs.ts tells the learner 'Hero is already in front' while hero holds no pair against a made pair

- **Location:** `packages/poker-math/src/outs.ts:567-582 (alreadyAheadNote), reached whenever equityNow >= aheadThreshold (0.50)`
- **Problem:** 'In front' is hand-strength language; equityNow is a two-cards-to-come equity. A flop hand with a big draw can clear 50% equity while losing at showdown, and the message then makes a false statement about the hand. It fires on the third liveCalculation in the shipped counting-outs lesson, whose caption says nothing about being ahead, so nothing on screen corrects it.
- **Fix:** Reword to be about equity rather than standing — 'Hero's equity is already above the threshold a card has to clear to count as an out, so read the counts as cards that keep hero's share up rather than as the size of a draw' — and better, compare heroScore against the opponent's current score before using the words 'in front'.
- **Missing test:** A test constructing a hand that is behind at showdown but above 50% equity (this exact fixture) and asserting the explanation does not claim hero is 'ahead' or 'in front'; plus the converse for a hand genuinely ahead.

### [D] No failsafe when hydration fails: boot overlay plus unrevealed sections leave a blank opaque page

- **Location:** `packages/ui/src/styles/components.css:1850-1870 and :1416-1441; apps/web/src/app/globals.css:600-620`
- **Problem:** Two mechanisms hide content until JS runs, and both guard the scripting-disabled case while neither guards scripting-enabled-but-JS-did-not-run. (1) .prl-boot is server-rendered data-state="pending", position:fixed inset:0, opaque --prl-surface-page, z-index 900, and only data-state="done" makes it transparent/pointer-events:none — set solely by JS, so §8's 900ms cap has no CSS enforcement. (2) The server emits data-revealed="false" on every Reveal (6 on home) and .prl-reveal[data-revealed="false"]{opacity:0}. CSS covers @media (scripting: none), prefers-reduced-motion and data-boot="skip" — none of which match a browser where scripting is enabled but the bundle failed. Result: an opaque full-viewport overlay over content that is itself invisible. components.css:1403-1404 explicitly claims the opposite: "Every failure mode - no JavaScript, no observer, an observer that never fires, a hydration that never happens - lands on 'the content is there'."
- **Fix:** Make the 900ms cap real in CSS — the layer globals.css itself argues for ("all three expressed in CSS rather than in JavaScript, because CSS applies before first paint and JavaScript does not"). Add a forwards animation on .prl-boot with animation-delay: var(--prl-dur-count) ending at opacity:0; pointer-events:none, keeping the component's transitionend unmount as the fast path; the pattern already exists two rules away. For reveals, either render data-revealed absent on the server (so CSS cannot hide it) or add the same time-based failsafe.
- **Missing test:** Load each route with the JS bundle blocked (intercept /_next/static/chunks/* → 404) while scripting stays enabled, then assert the boot overlay is not hit-testable at the viewport centre and that the h1 and every reveal have non-zero opacity. The existing scripting:none guard is untested and would pass such a test only by accident.

### [D] CORS allows only localhost:3000, so the equally-common 127.0.0.1:3000 silently degrades the whole app to fixtures

- **Location:** `.env / .env.example PUBLIC_WEB_ORIGIN; apps/web/src/lib/api.ts:42 (API_ORIGIN default http://localhost:3001)`
- **Problem:** PUBLIC_WEB_ORIGIN=http://localhost:3000 only. localhost and 127.0.0.1 are different origins, so a reader who opens the app at http://127.0.0.1:3000 — the address this review task itself specifies, and the one next start prints as a network alternative — receives no Access-Control-Allow-Origin header. Every browser fetch is blocked and the whole app falls back to fixtures with nothing in the UI to say so. Currently masked by P0-1 (nothing reaches the API anyway), so it will surface the moment P0-1 is fixed.
- **Fix:** Ship both loopback spellings in the dev default (PUBLIC_WEB_ORIGIN=http://localhost:3000,http://127.0.0.1:3000) and derive NEXT_PUBLIC_API_ORIGIN's host from window.location.hostname in development so the two always agree. Independently, the shell should surface some indication when the session call fails, as the legends screens already do.
- **Missing test:** A smoke assertion that every origin listed in PUBLIC_WEB_ORIGIN receives a matching ACAO header, plus a dev-mode check that the API origin's host matches the web origin's host.

### [G] Docs tell the operator to connect as prl_app, which is NOLOGIN; the required login-role step is documented nowhere

- **Location:** `docs/RUNBOOK.md:142-144 and :169 ('DATABASE_URL — Connect as prl_app, not as the owner') versus db/migrations/0001_initial.sql:98-104 (both roles created NOLOGIN with no password)`
- **Problem:** Following the runbook literally produces a boot failure. The migration comment explains the intent — the roles are privilege containers and 'the real login identities ... are granted membership out of band, by whatever manages secrets' — but no document tells a deployer to do that or how. Separately, nothing in the repository ever exercises the role: .env and docker-compose.yml:128 connect as the superuser `poker`, and ci.yml:232 connects as `postgres`, so least privilege is verified only statically by db:verify.
- **Fix:** Add a production database-setup section with the exact statements (CREATE ROLE prl_api LOGIN PASSWORD ...; GRANT prl_app TO prl_api; and the equivalent for the migrator) and correct RUNBOOK §7 to say 'connect as a login role that is a member of prl_app'. Consider making compose use such a role so the privilege set is exercised in development.
- **Missing test:** An integration test that runs the API's repository layer against a connection whose role is only a member of prl_app, so a query needing an ungranted privilege fails in CI rather than in production.

### [G] No CI job builds a container image or runs compose, so the two container defects could never be caught

- **Location:** `.github/workflows/ci.yml — jobs are supply-chain, lint, typecheck, test, exhaustive, build, a11y`
- **Problem:** Containers are a required deliverable and both are broken (wrong WORKDIR in Dockerfile.web; wrong environment in compose's api service), each catchable by a 30-second job. pnpm run build is not a substitute: it does not exercise the Dockerfiles' prune lists, the runtime working directory, the compose environment, or either HEALTHCHECK.
- **Fix:** Add a `containers` job: build both images, docker compose up -d, wait for both services healthy, then curl /api/v1/health on the published API port and / on the web port.
- **Missing test:** That job.

### [G] Deployment documentation omits the constraints that decide a deployment, including the one-API-process rule

- **Location:** `docs/RUNBOOK.md (no deployment section); docs/ARCHITECTURE.md §14; apps/api/src/rooms/registry.ts:11-16`
- **Problem:** Six things an operator needs are absent. (1) Only one API process may serve a room — registry.ts:11-16 states 'the authoritative live state is this process's memory ... this design assumes one API process per room ... two processes each holding "the" HandState for one room would deal two different hands', and ADR 0001 chose it, but RUNBOOK never says so, docker-compose.yml has no deploy.replicas: 1, and nothing mentions session affinity. (2) TLS/reverse proxy is mandatory in production (https origins and Secure cookies are enforced at boot) but unconfigured and undocumented, including its interaction with TRUST_PROXY. (3) No backup, restore or retention guidance for a database holding hand history and an audit log. (4) Dockerfile.api:93-97 deliberately omits apps/api/scripts, so migrations must run from outside the serving container, but nothing says from what. (5) No log destination or retention. (6) ARCHITECTURE §14 and RUNBOOK §10 describe shutdown behaviour that the shutdown finding shows is wrong.
- **Fix:** Add docs/DEPLOYMENT.md (or a RUNBOOK section) covering: one API replica and why, proxy and TLS termination, the prl_app login-role step, the NEXT_PUBLIC_API_ORIGIN build arg, migration ownership at deploy time, backup/restore, and log destinations. Add deploy.replicas: 1 (or an equivalent comment) to compose.
- **Missing test:** Not directly testable; a docs-claim checklist in CI (link check plus a grep for the digest TODO and the prl_app wording) would catch the adjacent documentation defects.

### [G] .env.example still ships the stale 8080 port in OIDC_REDIRECT_URI

- **Location:** `.env.example:126 (and apps/api/test/config.test.ts:315,323)`
- **Problem:** PORT=3001 is set 96 lines above, with a comment explaining that exactly this disagreement ('the API listened on 8080 while the browser called 3001') was a real bug. An OIDC redirect URI must match the API's origin exactly or the token exchange fails, and this commented example is the value a first-time configurer copies. The config test bakes the same wrong port into its fixture, normalising it.
- **Fix:** Change to http://localhost:3001/api/v1/auth/oidc/callback in .env.example and in the config test fixture.
- **Missing test:** A check that no port other than the configured PORT appears in an OIDC_REDIRECT_URI example.

### [G] .env.example claims wildcard origins are rejected at boot; they are accepted and the server starts with one in the allowlist

- **Location:** `.env.example:47-50 versus apps/api/src/config.ts:260-280 (normaliseOrigin)`
- **Problem:** normaliseOrigin validates scheme, credentials, query, fragment and path, but never the host shape, so `https://*.example` passes and the server boots with it. Impact is moderate because isAllowedOrigin is an exact match (security.ts:113-116) and therefore fails closed, but the operator gets 'CORS and every WebSocket are rejected' with no diagnostic, having been told the configuration was validated. One real hazard: safeRedirectTarget uses webOrigins[0] (apps/api/src/auth/oidc.ts:326-328), so a wildcard in first position produces a broken post-sign-in redirect.
- **Fix:** Reject a host containing '*' (and decide explicitly about a trailing dot) in normaliseOrigin, with a message naming the wildcard.
- **Missing test:** normaliseOrigin cases for https://*.example, https://app.example., https://0x7f.1 (currently normalised to https://127.0.0.1) and an IPv6 literal.

### [B] monteCarloEquity does not validate `samples`: NaN yields a NaN equity with a NaN interval, Infinity hangs the thread forever, and any value <= 1 reports a zero-width confidence interval

- **Location:** `packages/poker-math/src/equity.ts:515 (`const samples = Math.max(1, Math.floor(options.samples ?? DEFAULT_SAMPLES));`) and equity.ts:210 (Tally.firstPlayerStdDev returns 0 when trials < 2)`
- **Problem:** Math.floor(NaN) is NaN and Math.max(1, NaN) is NaN, so the trial loop never executes, tally.count is 0, and every division in toPlayerEquities produces NaN. Math.floor(Infinity) is Infinity, so `for (let trial = 0; trial < Infinity; trial++)` never terminates — a synchronous loop no timer or watchdog in the same thread can interrupt. Separately, firstPlayerStdDev returns 0 when trials < 2, so a single-sample run reports a +/-0.00-point 95% interval — a claim of certainty from one trial. This matters because every other entry point in the package validates exhaustively and says so (odds.ts: "Nothing here returns NaN, and nothing is silently clamped"), and because equity() is a public API of a package documented as *bounded* Monte Carlo.
- **Fix:** Validate at the top of monteCarloEquity in the style the rest of the package already uses: reject a `samples` that is not an integer >= 1, and reject one above a hard ceiling — `if (!Number.isInteger(requested) || requested < 1) throw new EquityError(...)`. Validate `seed` as an integer for the same reason. Make a sub-2-sample run report its interval honestly rather than as zero: either refuse samples < 2, or return halfWidthPoints: null with a note, mirroring the exact path's deliberate choice of null over 'a fabricated 0' (which coach.test.ts already asserts for enumeration).
- **Missing test:** A hostile-input table asserting EquityError for `samples` of NaN, Infinity, -Infinity, -5, 0, 0.5, Number.MAX_SAFE_INTEGER, '1000' and null, and the same for `seed`. Plus an invariant test over every result the function can return: Number.isFinite(result.players[i].equity) for all i, and result.confidence === null || result.confidence.halfWidthPoints > 0.

### [B] CoachSuggestion.sizeRange is the full sizing ladder, not a range of defensible sizes

- **Location:** `packages/poker-math/src/coach.ts:290-297 and 332-333`
- **Problem:** sameActionSizes collects the `to` of EVERY candidate matching the chosen action, including the all-in, regardless of how much worse its EV is, and sizeRange is the min/max of that. The requirement is for 'a suggested action and size range'; a range that always covers the whole ladder carries no information and actively misleads, because it reads as 'anything in here is fine'.
- **Fix:** Restrict the range to candidates within the indifference margin of the best one — the same one-big-blind yardstick buildSuggestion already uses to downgrade confidence: `.filter((c) => c.action === best.action && c.to !== undefined && c.ev >= best.ev - input.bigBlind)`. When only one size qualifies, emit a single value or omit sizeRange rather than a spurious span.
- **Missing test:** Assert that every `to` inside suggestion.sizeRange belongs to a candidate whose EV is within the margin of the best, and that a candidate priced far below the best (the all-in in the spot above) is excluded. Also assert sizeRange.min <= sizeRange.max and that both endpoints are legal raise sizes per the illegal-raise-size finding.

### [B] No test anywhere asserts a Coach candidate EV against an independently derived number

- **Location:** `packages/poker-math/test/coach.test.ts (15 tests, all passing)`
- **Problem:** The coach tests assert structural and relative properties only: assumptions are non-empty and are real sentences; a sampled figure carries an interval and an exact one reports null; no string contains 'correct'/'optimal'/'GTO'; every `to` is an integer; no candidate costs more than the stack; a wider range raises equity; the same report is produced twice for the same input. Not one test compares a candidate's `ev` against a figure derived independently of buildCoachReport. That is precisely why the P0 raise-EV defect has survived: the raise formula could be replaced with almost anything and all 15 tests would still pass.
- **Fix:** Add hand-computed numeric assertions for fold, check, call, bet and raise at a fixed spot with a fixed equity, with the arithmetic written out in the test body as a comment so a reader can verify it without running anything — the style ev.ts and odds.ts already use. Give the 'flips from raise to fold' test a stack that leaves chips behind so it actually exercises the raise path.
- **Missing test:** As above: at least one exact-value assertion per action type, sourced from arithmetic in the test body rather than from another call of the function under test.

## P3 (36)

### [A] apps/web declares @prl/content, which ARCHITECTURE.md forbids, and never imports it

- **Location:** `apps/web/package.json:14; docs/ARCHITECTURE.md:81`
- **Problem:** apps/web declares "@prl/content": "workspace:*" while docs/ARCHITECTURE.md:81 lists the web app's allowed dependencies as contracts, ui, poker-math and its forbidden actions as "import @prl/content, or compute anything authoritative". @prl/content reads JSON with node:fs and is server-only. Nothing imports it today, so nothing breaks — but the declaration is what would let a future accidental import resolve silently. Conversely apps/web does import @prl/poker-engine (legitimately, for client-side commitment verification) which the doc's table does not list as allowed.
- **Fix:** Remove @prl/content from apps/web/package.json. Update the ARCHITECTURE.md dependency table to list @prl/poker-engine as allowed for the web app, since client-side reveal verification is a stated requirement.
- **Missing test:** A boundary test that reads each apps/*/package.json and asserts its dependencies are a subset of the set ARCHITECTURE.md declares, so doc and manifests cannot drift.

### [A] Every unknown route answers content_not_found — "That lesson, quiz or scenario does not exist."

- **Location:** `apps/api/src/errors.ts:401-403 and :240; packages/contracts/src/errors.ts:159`
- **Problem:** The route-level 404 handler maps all unknown paths to content_not_found, whose message names lessons, quizzes and scenarios. The code choice is deliberate and well argued (a distinguishable "route exists, id does not" would map the API surface), but the copy is factually wrong for /, /admin, and for an unknown hand or room — and hand_not_found and room_not_found_or_not_permitted already exist with correct messages.
- **Fix:** Give content_not_found a neutral message ("That resource does not exist."), or add a generic not_found code with the same 404 status for the route-level handler so the content-specific wording is reserved for content routes.
- **Missing test:** Assert GET / and GET /api/v1/<unknown> return a message that does not name lessons, quizzes or scenarios.

### [A] HandReviewResponse.reveal is typed unknown in the contract

- **Location:** `packages/contracts/src/api-types.ts:397`
- **Problem:** `readonly reveal: unknown;` types the Merkle reveal — the payload whose verification is the product's entire fairness argument. @prl/contracts already depends on @prl/poker-engine, which exports DeckReveal, so the precise type is available and the erasure is unnecessary.
- **Fix:** Type it as DeckReveal (imported from @prl/poker-engine) and keep the runtime parser in CommitmentVerifier as the trust boundary.
- **Missing test:** A type-level assertion that HandReviewResponse['reveal'] is assignable to DeckReveal.

### [A] Stale module documentation asserts that shipped modules do not exist, which is why the P0 path bug reads as intentional

- **Location:** `apps/web/src/fixtures/learn.ts:6-7; apps/web/src/fixtures/table.ts:6; apps/web/src/lib/legends-data.ts:19`
- **Problem:** fixtures/learn.ts states "apps/api/src/routes/content.ts does not exist yet — another team is writing it." It exists and is 1,074 lines. legends-data.ts:19 states "LEGEND_API_PATHS is provisional: the routes are the API team's to name." These comments document a build-out phase that has ended, and their survival is the signal that the fixtures were never revisited after the API landed.
- **Fix:** Delete these comments as part of the P0-1 fix, and state instead that fixtures exist only as an offline fallback with a named, tested drift check against packages/content/data.
- **Missing test:** A content-parity test asserting the web fixture ids are a subset of the canonical ids in packages/content/data, so a fixture referencing a nonexistent lesson or scenario fails the build.

### [A] Dead exports in apps/web/src/fixtures/session.ts

- **Location:** `apps/web/src/fixtures/session.ts:39,53,68`
- **Problem:** FIXTURE_USER, FIXTURE_SESSION and ANONYMOUS_SESSION are exported but never imported anywhere. Only STARTING_UNITS from that module is used.
- **Fix:** Delete the three exports, or wire them into the session fallback that the P0-1 fix will need once fetchSession can actually succeed or fail meaningfully.
- **Missing test:** A lint rule or CI check for unreferenced exports in apps/web/src (Biome can be configured for this), so orphaned fixture surface is caught automatically.

### [C] No dedicated rate limit on POST /rooms/join (invite-code guessing)

- **Location:** `apps/api/src/routes/rooms.ts:278-286 — registered with a body schema and no `config`, so it inherits only the global limiter (plugins/security.ts:630-639, RATE_LIMIT_MAX=300 per 60s).`
- **Problem:** docs/THREAT-MODEL.md §T8 names 'Room enumeration and uninvited joining' as a tracked threat. The auth routes get clientKeyedRateLimit and the calculation routes get app.expensiveRateLimit, but the one route that accepts a guessable secret gets neither. To be honest about the actual risk: invite codes are 16 characters from a 31-symbol alphabet (apps/api/src/repositories/ids.ts:85-93), about 79 bits, so at 300 attempts/minute brute force is not a threat in any timeframe. The finding is about defence consistency and bucket sharing — 300/min of join attempts also consumes the caller's global budget for everything else, and a dedicated smaller bucket is both stricter and cheaper.
- **Fix:** Apply clientKeyedRateLimit(config, 20, 60_000) to POST /rooms/join — address-keyed rather than session-keyed, for the same reason routes/auth.ts:89 gives: a code-guessing client can discard its cookie freely.
- **Missing test:** An integration test that sends N+1 wrong invite codes and asserts a 429 — the same shape as the existing guest-creation rate-limit check in scripts/smoke-test.mjs §10, which is what caught the analogous hole (prior defect #7) in the first place.

### [C] THREAT-MODEL G10 and SECURITY.md §6 claim a container gap that does not exist

- **Location:** `docs/THREAT-MODEL.md §9 row G10; docs/SECURITY.md §6 final bullet.`
- **Problem:** Both documents state that base images 'may not be digest-pinned … marked TODO rather than filled with a fabricated digest'. Every image in the repository IS digest-pinned and there is no TODO. A threat model that lists an accepted gap which has since been closed costs credibility on the gaps that are real.
- **Fix:** Delete G10 from THREAT-MODEL.md §9 and the matching bullet from SECURITY.md §6, or rewrite them as a CONTROL ('all base images are digest-pinned; see …') with a review trigger for when a digest is refreshed.
- **Missing test:** A repo-hygiene check that fails if any `FROM` or compose `image:` lacks an @sha256: digest — making the claim enforced rather than narrated, so the doc cannot drift again.

### [C] The SBOM is gitignored, so the required deliverable is not in the repository

- **Location:** `.gitignore — `docs/sbom/*.json` with `!docs/sbom/.gitkeep`.`
- **Problem:** An SBOM is a named deliverable. It is generated correctly and is valid, but it is excluded from version control, so a consumer cloning the repo gets an empty docs/sbom/. It exists only as a CI artifact (ci.yml:126, ci.yml:400, supply-chain.yml:99). This also contradicts docs/SECURITY.md §4, which advertises the SBOM's byte-stability as a version-control benefit: 'The SBOM is content-derived and byte-stable, so `git diff` shows dependency changes rather than a fresh timestamp.' There can be no git diff on an ignored file.
- **Fix:** Commit docs/sbom/poker-risk-lab.cdx.json (it is byte-stable by design so it will not churn), keeping osv-report.json and provenance-report.json ignored if those are genuinely run-dependent. Or, if the SBOM is meant to be build-only, correct SECURITY.md §4 so it stops promising a git diff that cannot happen.
- **Missing test:** A hygiene check asserting docs/sbom/poker-risk-lab.cdx.json is tracked and that regenerating it produces no diff — which simultaneously proves the byte-stability claim.

### [E] test:a11y defaults to crawlDepth 1, so CI audits six index routes and zero detail pages

- **Location:** `scripts/a11y-audit.mjs:153-165 (routes: ['/'], crawlDepth: 1, maxRoutes: 12); .github/workflows/ci.yml a11y job`
- **Problem:** The default run audits /, /learn, /play, /lab, /legends, /review. apps/web/src/app contains 13 page.tsx route templates; the seven detail templates (/learn/[lessonId], /learn/glossary, /lab/[scenarioId], /legends/[profileId], /legends/compare, /legends/hand-review, /review/[handId]) are never audited even though the index pages link to them in server-rendered HTML — maxRoutes is never reached, crawlDepth is what stops it. Those pages carry the radar charts, Coach panel, quiz forms and analytics tables.
- **Fix:** Raise the default crawlDepth to 2, or have the CI a11y step pass --routes seeded with one instance of each dynamic template (e.g. /learn/pot-odds,/lab/flop-flush-draw-price,/legends/calling-station,/legends/compare,/legends/hand-review,/learn/glossary) and a matching --max-routes.
- **Missing test:** An assertion inside a11y-audit.mjs that the set of audited routes covers every page.tsx template under apps/web/src/app (one concrete instance per dynamic segment), so a new page cannot silently escape the audit.

### [E] Zero component render tests; apps/web has no test script at all

- **Location:** `packages/ui/src/components/ (21 components, ~3,600 lines); apps/web (20,937 lines, no test script in package.json); packages/ui/test/ (6 files, helpers only)`
- **Problem:** No test file in the repository imports a .tsx. CoachPanel (643 lines), ActionBar (365), Metric (313), PokerTable (310), Seat (222), RadarChart (181) and TurnTimer (161) have no behavioural coverage, and the React hooks (useCountUp, useReveal, usePrefersReducedMotion) are untested — motion.test.ts covers only the pure easing/token/reduced-motion helpers. apps/web has no test script, which is why pnpm run test:unit prints 'Scope: 6 of 9 workspace projects'. The frontend requirement (design system, loading transition, section reveals, count-up metrics, immersive table, premium Coach panel, Legend cards, Scenario Lab and Hand Review analytics, responsive breakpoints, loading/error/completed-hand states, dark AND light mode) rests entirely on tsc --noEmit, a static markup audit of six routes, and check-contrast.mjs parsing CSS tokens.
- **Fix:** Add a render-test setup for @prl/ui (react-dom/server renderToStaticMarkup needs no DOM and no new runtime dependency for markup assertions; a DOM-based runner would be a dependency decision for the maintainers) and cover at minimum: CoachPanel's loading/error/populated states, ActionBar's legal-action gating and bet-size clamping, PokerTable's seat rendering, and the three motion hooks under prefers-reduced-motion. Give apps/web a test script even if it starts with a single route-render smoke test, so pnpm -r test stops skipping a third of the workspace.
- **Missing test:** As above, plus a light/dark snapshot of the token-consuming components — 'dark AND light mode' currently has only check-contrast.mjs behind it, which parses CSS and never renders a component.

### [E] A divergence test whose loop can execute zero times, and two profile axes with no declared-vs-observed bound

- **Location:** `packages/poker-ai/test/simulation/profile-differentiation.test.ts:345-363`
- **Problem:** The only assertion inside the loop over `divergences` is assert.deepEqual(findImpersonation(sentence), [], sentence). If compareToDeclared ever returned an empty divergences array the test would pass having asserted nothing — the 'loop that could execute zero times' pattern. The file is explicit that aggressionFrequency and threeBetTendency are deliberately unbounded, and the stated reasons are sound (declared as a neutral-hand rate and a range multiplier respectively, not as unconditional frequencies), but the consequence is that these two axes have no declared-vs-observed check at all.
- **Fix:** Add assert.ok(lines.length > 0) or, better, an explicit expected-divergence-key set so the loop cannot silently vanish and a NEW divergence is a failure rather than a log line. Then either bound these two axes on their own scale, or assert their ORDERING across profiles — the suite already does exactly that for VPIP, PFR and aggression via Spearman rho (0.9510 for aggression), so the machinery exists.
- **Missing test:** A test that the declared threeBetTendency and aggressionFrequency orderings are reproduced by the observed 3-bet and aggression rates (Spearman rho with a floor), which is the strongest claim that is actually true for a multiplier-shaped trait.

### [E] A fuzz coverage counter that is collected but never asserted

- **Location:** `packages/poker-engine/test/invariants.test.ts:163 (sawAllInPreflop), :212, :238-244`
- **Problem:** The 4,000-hand fuzz asserts coverage for reachedShowdown (>200), endedByFold (>200), sawSidePots (>100) and all four streets, but sawAllInPreflop is only printed. A generator change that stops producing sub-blind stacks — the case the fixture deliberately includes — would remove that path from coverage silently.
- **Fix:** Add assert.ok(sawAllInPreflop > 0, `the fuzz never produced an all-in before the flop, so that path was not exercised`) alongside the other four.
- **Missing test:** The assertion itself is the missing test.

### [E] Documentation drift around the test commands

- **Location:** `docs/RUNBOOK.md:64-72`
- **Problem:** The RUNBOOK's test table omits pnpm run test:smoke, pnpm run db:verify and the poker-ai simulation suite — three suites that pass and assert things nothing else does. It lists pnpm run test:load as 'configurable' with no note that it needs an origin matching PUBLIC_WEB_ORIGIN and a raised rate limit, so a reader following the RUNBOOK gets a hard 100%-error failure. The review brief describes the smoke test as 36 checks; it emits 37.
- **Fix:** Add rows for test:smoke, db:verify and the poker-ai simulation suite with their real runtimes; annotate test:load with its origin and rate-limit prerequisites (or fix the harness per the P1 finding and drop the caveat); correct the smoke-test check count wherever it is quoted.
- **Missing test:** A docs test asserting that every root package.json script matching /^(test|db|security):/ appears in docs/RUNBOOK.md — cheap, and it stops this whole class of drift.

### [F] Truncated sentence in docs/AI-LEGENDS.md

- **Location:** `docs/AI-LEGENDS.md:169-171`
- **Problem:** The sentence 'It does **not** catch a proper noun followed' ends mid-clause and runs straight into the next paragraph. Introduced by the edit that added the two new impersonation patterns (previously-found defect 8). As written it also contradicts the paragraph immediately below, which says the shape IS now caught.
- **Fix:** Finish or delete the sentence.
- **Missing test:** None practical; a doc lint for sentences ending without terminal punctuation would catch it.

### [F] Stale limitation L7 in docs/AI-LEGENDS.md claims gaps in the impersonation guard that are now closed

- **Location:** `docs/AI-LEGENDS.md:623`
- **Problem:** L7 still claims the guard 'does not catch a proper noun followed by a mental-state verb, nor he/she/they would <verb> outside four listed verbs' and proposes as the remedy 'Assert that no naming.attributedName string appears anywhere in generated commentary.' All three statements are out of date: labelling.ts:207-221 catches the capitalised-name-plus-mental-state-verb shape and bans gendered pronouns outright, and commentary.ts:246-260 already implements the proposed name check derived from PROFILES.
- **Fix:** Rewrite L7 to describe what genuinely remains uncovered (e.g. surname-only 'the real Hellmuth', see the separate finding).
- **Missing test:** None; prose.

### [F] docs/AI-LEGENDS.md L10 claims tournamentOrientation uses Malmuth–Harville ICM; it does not

- **Location:** `docs/AI-LEGENDS.md §12 L10; the actual implementation is packages/poker-ai/src/policy.ts:1061`
- **Problem:** L10 says 'Tournament instincts inherit the ICM model's approximations. tournamentOrientation weights survival using Malmuth–Harville, which ignores skill, position and blind pressure'. poker-ai never imports ICM at all. The trait's only effect is a linear multiplier on the fold weight, with no payout schedule, no stack distribution and no finishing-place model. The claim overstates the model in the section of the document that exists precisely to understate it.
- **Fix:** Replace L10 with what the code does. (The separate ICM lesson in packages/content is genuinely honest about the approximation and needs no change.)
- **Missing test:** An assertion that @prl/poker-ai does not depend on icm.ts, so the doc and the import graph cannot disagree.

### [F] packages/poker-ai/src/traits.ts still says 'eleven' profiles where the set is twelve

- **Location:** `packages/poker-ai/src/traits.ts:4, :6, :291`
- **Problem:** 'Why a trait vector and not eleven hand-written strategies', 'Eleven bespoke strategies would be eleven things to test, eleven places for a bug', 'rather than being eleven variations on one'. PROFILES.length is 12 and docs/AI-LEGENDS.md says twelve throughout.
- **Fix:** Update the three comments, or phrase them without a count.
- **Missing test:** A test asserting PROFILES.length matches the row count of the profile table in docs/AI-LEGENDS.md, so the two cannot drift.

### [F] Imprecise variance wording in the sample-size-and-risk-of-ruin lesson

- **Location:** `packages/content/data/lessons/decisions.json, lesson 'sample-size-and-risk-of-ruin', the risk-of-ruin formula block's explanation`
- **Problem:** 'risk falls exponentially as the bankroll grows, it falls exponentially as the edge grows, and it rises with the square of the standard deviation. Variance is the only one of the three that enters squared, which is why it dominates the answer.' It is the standard deviation that enters squared; variance (sigma^2) enters to the first power. In a lesson whose subject is exactly this distinction the loose use of 'variance' for 'the spread' is worth fixing.
- **Fix:** Say 'the standard deviation is the only one of the three that enters squared'.
- **Missing test:** None; prose.

### [F] Two scenario claim kinds are implemented but never used by any shipped content

- **Location:** `packages/content/src/scenario-analysis.ts:296-352 (dirtyOutsAtLeast, equityBetween, breakEvenEquityBetween, sprBetween and the default branch handling ruleOf24ErrorAtMost)`
- **Problem:** The content suite reports '36/36 scenarios carry claims: 74 independent verification, 0 regression locks', so none of the five quantitative claim kinds is exercised by real content and the default: branch handling ruleOf24ErrorAtMost is unreachable from the shipped data.
- **Fix:** Either use them — a ruleOf24ErrorAtMost claim on the rule-of-2/4 scenarios would be genuinely valuable — or delete the unused branches.
- **Missing test:** A coverage assertion that every ScenarioClaim['kind'] appears in at least one shipped scenario, or an explicit allow-list of unused kinds with a reason.

### [F] docs/AI-LEGENDS.md §7 overstates what the hidden-information test instruments

- **Location:** `docs/AI-LEGENDS.md §7 versus packages/poker-ai/test/no-hidden-information.test.ts:339`
- **Problem:** §7 says 'The policy input is wrapped in a Proxy that records every property path read'. In the shipped test only input.view is wrapped; the other six keys — including `observations`, the one a privileged caller could actually use as a side channel — are passed raw. The property does hold (I wrapped all seven keys over 1,267 decisions and the read set was clean), but the doc describes a stronger test than the one that runs.
- **Fix:** Wrap the whole PolicyInput in the shipped test — a two-line change that costs nothing — or narrow the doc.
- **Missing test:** The whole-input proxy version, asserting the top-level key set is exactly the seven permitted and that no read path under `observations` returns a card.

### [F] The 'real <first name>' impersonation pattern is a hand-maintained first-name list

- **Location:** `packages/poker-ai/src/labelling.ts:231`
- **Problem:** pattern: /\breal\s+(?:Phil|Doyle|Erik|Johnny|Daniel|Michael|Shaun|Benny)\b/i covers today's ten attributed names by first name only, so 'the real Hellmuth' and 'the real Negreanu' pass, and adding a profile whose first name is not listed silently loses coverage. commentary.ts:227-248 already derives its token list from PROFILES — the same technique applies here.
- **Fix:** Build the pattern from naming.attributedName tokens rather than typing names in. labelling.ts cannot import profiles.ts without a cycle, so either move this check into commentary.ts (which already has the token list) or inject the tokens.
- **Missing test:** For every attributedName in PROFILES, assert findImpersonation('the real ' + token) is non-empty for each of its name tokens.

### [F] apps/web/src/lib/legends-data.ts documents its own network contract as provisional

- **Location:** `apps/web/src/lib/legends-data.ts:43-46`
- **Problem:** 'Provisional endpoint paths. The API team owns the final names; the /api/... prefix follows the one route that already exists (GET /api/session).' The referenced route does not exist either — /api/session and /api/v1/session both 404; the real session route is /api/v1/auth/session. A release should not ship a comment saying its own network contract is unsettled, and this is the comment that documents the P0's root cause.
- **Fix:** Replace with the real, versioned paths imported from a shared constant; the comment then becomes unnecessary.
- **Missing test:** Covered by the P0's test (a) — assert every declared API path resolves to a registered route.

### [D] pnpm run test:a11y audits only 6 of 13 routes by default

- **Location:** `scripts/a11y-audit.mjs:157-158 (maxRoutes: 12, crawlDepth: 1)`
- **Problem:** Crawling one level from / reaches only the five nav destinations, so the seven detail routes (lesson, glossary, scenario detail, profile detail, compare, hand-review, hand detail) are never audited even though the route cap has headroom. A regression on any of them would not be caught by the gate.
- **Fix:** Set crawlDepth: 2, or seed the known route list explicitly.
- **Missing test:** Assert the audited route count equals the number of page.tsx files under apps/web/src/app, so adding a route without covering it fails the gate.

### [D] Two lint warnings on a release gate that still exits 0

- **Location:** `packages/content/src/validate.ts:670 and :865`
- **Problem:** lint/complexity/noExcessiveCognitiveComplexity: complexity 36 and 33 against a max of 24. Not frontend code, but pnpm run lint is a release gate and passes while warning, so the warnings are invisible in CI.
- **Fix:** Extract per-section validators from validateContent and its sibling at :670.
- **Missing test:** Run Biome with --error-on-warnings in CI so a warning cannot accumulate silently.

### [D] The brand link's accessible name loses a word below 860px

- **Location:** `apps/web/src/app/globals.css:181-183 (.prl-shell__brand-tail { display: none })`
- **Problem:** The tail " Lab" is removed with display:none below 860px, so the home link's accessible name becomes "00 Poker Risk" — the product name minus a word — for every mobile and tablet user, screen-reader users included. The pixel saving is deliberate and documented; the accessible-name loss looks unintended.
- **Fix:** Swap display:none for the existing .prl-visually-hidden treatment on the tail so the accessible name survives while the pixels do not.
- **Missing test:** Assert the brand link's accessible name is "Poker Risk Lab" at 390, 834 and 1440.

### [D] Equity-bar legend rows are visually inconsistent when a series label wraps

- **Location:** `packages/ui/src/components/EquityBar.tsx / .prl-equity-bar__row in packages/ui/src/styles/components.css`
- **Problem:** The two series rows measure 46px and 82px. The long second label ("Cutoff, the assumed continuation-betting range") wraps, pushing its colour swatch onto its own line and its percentage onto a third, so the two series no longer scan as a pair: row 1 reads "▣ You, ace-king of hearts … 54.1%" on one line, row 2 does not. Cosmetic only — both values and both fill patterns are present and correct, so §6.2's clean/dirty and per-player distinctions still hold.
- **Fix:** Give the row grid-template-columns: auto 1fr auto so swatch/label/value keep their columns regardless of label length.
- **Missing test:** Snapshot the legend row heights with a deliberately long series label and assert the swatch stays on the label's first line.

### [G] README links docs/REPORT.md, which does not exist

- **Location:** `README.md:237`
- **Problem:** The documentation table's last row links 'docs/REPORT.md — Final delivery report: what was built, tested, and left undone'. The file is absent. It is the only broken relative link in the repository's markdown.
- **Fix:** Write the report or remove the row.
- **Missing test:** A markdown link check in CI.

### [G] RUNBOOK sends the reader looking for a base-image-digest TODO that does not exist

- **Location:** `docs/RUNBOOK.md:157-159`
- **Problem:** 'Before any real deployment: check Dockerfile.api and Dockerfile.web for a TODO on the base-image digest. Where a digest could not be verified at authoring time, the tag is used and marked.' Both Dockerfiles are digest-pinned and contain no TODO, as is compose's postgres image. The instruction is stale and undersells the work that was done.
- **Fix:** Replace with 'base images are digest-pinned; refresh with the registry command in Dockerfile.api's header'.
- **Missing test:** A check that every FROM and every compose image: carries an @sha256:.

### [G] Agent instruction files ship inside the production web image

- **Location:** `.dockerignore:10 (`*.md`), against Dockerfile.api:121-123 and Dockerfile.web:66-67 which both assert *.md is excluded`
- **Problem:** Docker ignore patterns are anchored to the context root, so `*.md` does not match apps/web/*.md. Internal agent instructions are shipped in the production image.
- **Fix:** Use `**/*.md` in .dockerignore (with an explicit exception if any markdown is needed at runtime).
- **Missing test:** An image test asserting the shipped filesystem contains no .md outside node_modules.

### [G] packages/contracts has no test files, so its test script cannot fail

- **Location:** `packages/contracts/package.json ("test": "node --test 'test/**/*.test.ts'"); no test/ directory exists`
- **Problem:** node --test with no matching files exits 0, so this package's slot in the test:unit gate is inert. It matters more than usual because @prl/contracts is where the shared route paths should live to fix the client/server URL mismatch.
- **Fix:** Add tests (schema round-trips, error-code exhaustiveness, path constants), or make the runner fail when zero tests are discovered.
- **Missing test:** A meta-check that every workspace package declaring a `test` script discovers at least one test.

### [G] next dev and next build share one .next directory, and the result is a production server whose JS 503s with no build-time error

- **Location:** `apps/web/package.json scripts (dev, build, start all use the same .next), and RUNBOOK §3 which does not mention cleaning between them`
- **Problem:** Running next dev and then next build in one checkout leaves the build manifests referencing dev-only chunks that the production build never emits. next start then returns 200 for every page while the client never hydrates. This is the current state of the shared web server on :3000: the boot overlay never clears and no count-up runs.
- **Fix:** Have `build` clean first (node scripts/clean.mjs --next && next build), or state in RUNBOOK §3 that pnpm run clean is required between dev and build.
- **Missing test:** A post-build check that every chunk referenced under .next exists on disk — ten lines, and it closes this class permanently.

### [G] The boot overlay's completion depends solely on requestAnimationFrame, so a hidden tab keeps a full-viewport pointer-events overlay up indefinitely

- **Location:** `apps/web/src/components/BootSequence.tsx:112-118`
- **Problem:** The component documents four exits (reduced motion, repeat visit, a 900 ms cap, no scripting) and all are real, but the 900 ms cap is measured inside the rAF loop. In a hidden tab rAF never fires, so nothing advances and the overlay — position: fixed, full viewport, z-index 900, pointer-events: auto — stays up. It self-heals when a human foregrounds the tab, which is why this is P3, but it makes automated end-to-end testing impossible without a foregrounded tab and is a hazard for prerender or occluded-window cases.
- **Fix:** Add a setTimeout(..., remaining) alongside the rAF loop as the authoritative cap — which makes the file's own '900ms end to end no matter what' true — or dismiss on visibilitychange when hidden.
- **Missing test:** A test that mounts BootSequence with requestAnimationFrame stubbed never to fire and asserts the overlay is removed by the deadline.

### [G] A routine 403 CSRF rejection logs a full stack trace containing absolute filesystem paths

- **Location:** `apps/api/src/errors.ts / the error handler path reached from apps/api/src/plugins/security.ts:626`
- **Problem:** An expected client-side condition costs a full stack trace at warn level, and the trace discloses install paths. The response body is correctly minimal (code, generic message, requestId); only the log is noisy.
- **Fix:** Log expected 4xx conditions at info/warn with the error code only, reserving the `err` field (with stack) for 5xx.
- **Missing test:** A logging test asserting no err.stack field is emitted for a csrf_failed or invalid_request rejection.

### [B] poker-ai re-implements breakEvenEquity, against the single-definition rule odds.ts states explicitly

- **Location:** `packages/poker-ai/src/commentary.ts:398, used at lines 640, 696, 697 and 832`
- **Problem:** commentary.ts defines its own local breakEvenEquity(potBefore, toCall) = toCall / (potBefore + toCall). It is currently arithmetically identical to potOdds().breakEvenEquity, so nothing is wrong today — but odds.ts:59-62 states the rule it breaks: 'Prices live in odds.ts ... so that the package has exactly one definition of each and one place to be wrong.' Replay commentary and the Coach panel can silently disagree after any future edit to either.
- **Fix:** Delete the local function and import potOdds from @prl/poker-math, as policy.ts already does.
- **Missing test:** A cross-package assertion that the commentary's stated price equals potOdds(pot, toCall).breakEvenEquity over a table of pot/call pairs. More cheaply: a source-scan test forbidding a second definition of a named price formula outside odds.ts — the repo already has exactly this pattern for Math.random ('src/ never uses Math.random in code', plus a test that the scan would actually catch a violation).

### [B] packages/contracts has an empty test/ directory and pnpm test reports 0 tests as success

- **Location:** `packages/contracts/test/ (empty), packages/contracts/package.json -> "test": "node --test 'test/**/*.test.ts'"`
- **Problem:** Contracts is the package that defines the API surface, the JSON schemas and the shared types — including the samples: {minimum: 1_000, maximum: 500_000} bound that is currently the only thing standing between the monteCarloEquity validation gap and a permanently wedged worker thread. Nothing verifies any of it, and the empty directory plus a passing test script makes a zero-test package look tested.
- **Fix:** Either add schema round-trip tests — one accepted fixture and one rejected fixture per constraint (oversized boards, out-of-range sample counts, wrong types, duplicate cards), asserting the specific validation error — or remove the empty directory and the test script so a zero-test package cannot be mistaken for a tested one.
- **Missing test:** Per exported schema: a valid payload that validates, and one hostile payload per declared constraint that is rejected with the expected message.

### [B] DEFAULT_ASSUMED_FOLD_EQUITY = 0.35 is a hard-coded probability applied uniformly to every aggressive candidate

- **Location:** `packages/poker-math/src/coach.ts:77`
- **Problem:** Not a guardrail violation — it is disclosed on every candidate as foldEquityAssumed, named in whatWouldChangeIt ('This assumes the line wins uncontested 35% of the time'), and overridable via assumedFoldEquity. I am explicitly NOT reporting it as a hard-coded odds violation. It is a design observation: applying a fixed 35% uniformly across every board, street, bet size and opponent range makes aggression look good almost everywhere, which undercuts the bet-sizing lessons the app is built to teach.
- **Fix:** Derive the default from the opponent profile's modelled fold frequency where one is available, or at minimum scale it with bet size — a 3x overbet does not win uncontested as often as a third-pot stab. Keep the disclosure either way.
- **Missing test:** A distribution test over the shipped scenarios asserting the Coach's recommended action is not identical in every one of them, and that at least one scenario with a negative equity surplus recommends fold.

# Lead coordinator's own findings

Found by me while the reviewers were in flight, recorded here so provenance stays clear.
Full detail in the working notes; both are carried into the fix list.

- **LEAD-1 (P1)** — the recorded CSP hash for the theme boot script is stale
  (`apps/web/src/lib/theme.ts:189`). Recorded
  `sha256-Cx7XX8I3RcQFy1KDpe0KQu4jsN9nyUsHVaHZ8vQyzZQ=`; actual
  `sha256-pFr/J6mAOwOBw+OUbWRw3SFuJuxHv7yTRXbAhz9wOxo=`. Nothing enforces it today, so it
  is wrong documentation rather than a broken page — but an operator who follows it ships a
  CSP that blocks the one script that exists to prevent a theme flash. The root cause is
  that the value was reviewable but not verifiable, so the fix adds a test that recomputes
  it.
- **LEAD-3 (P1)** — reviewer agents left 818 lines of scratch probe tests in the repository
  (`packages/poker-ai/test/zz-review-*.test.ts`,
  `packages/poker-math/test/zz-review-coach.test.ts`), which break `lint` (6 errors) and
  `typecheck` (2 errors). No production source was modified. This is my defect: the A–G
  brief never said where to put scratch work. Some of these probes are genuinely valuable
  independent ground truth and will be promoted before the files are deleted.

# Process note on evidence quality

One methodological point worth recording, because it shaped how I treated every finding
above. While verifying a reviewer's claim about `skipLibCheck`, my first command invoked a
tsc binary at a path that does not exist. It exited 127 and printed nothing, which I briefly
read as "zero type errors" — evidence for a conclusion that was the opposite of the truth.
Re-run against the real binary, the reviewer's number reproduced exactly (75 errors, all
inside `node_modules`, none in repo code) and their change was justified.

A check that cannot distinguish "passed" from "never ran" is not a check. Every gate in the
final release gate records its exit code for this reason, and I re-derived each P0 in this
register from its own reproduction rather than accepting any reviewer's summary — including
the ones I agreed with.

---

# Findings discovered DURING remediation

Defects that did not exist in the A–G reports because they were only reachable once an
earlier fix landed, or were uncovered by a fixer going deeper than the reviewer had. They
are recorded here with the same discipline as the originals.

## REM-1 — P2 — `pressureTendency` and `barrelPersistence` are documented as "how much" but applied to "how often"

**Found by:** the `packages/poker-ai` calibration fixer, while closing the profile-drift P2.
**Status: NOT FIXED. Carried as a known limitation.**

`traits.ts` says of `pressureTendency`: *"Separate from `aggressionFrequency`, which is about
how often: this is about how much."* In `policy.ts` both traits multiply the aggressive
**weight**, and are neutral only at trait value 0.5 — so the realised neutral-hand aggression
rate is pulled by `(trait − 0.5)`. The relationship is monotone across the shipped set:

| `pressureTendency` | 0.84 | 0.80 | 0.78 | 0.72 | 0.60 | 0.54 | 0.48 | 0.38 |
|---|---|---|---|---|---|---|---|---|
| observed − declared | +0.057 | +0.050 | +0.039 | +0.028 | +0.018 | −0.021 | −0.055 | **−0.114** |

`disciplined-specialist` holds the lowest pair (0.38 / 0.38) and therefore the largest
residual: it spends **0.138 of its 0.18 allowance, leaving a margin of 0.042**.

**Why it is not fixed here.** Correcting it means retuning the scoring model — changing how
often every profile acts — which requires full re-validation of all twelve profiles against
their cards. That is a larger and riskier change than the definitional fix it sits behind,
and doing it under time pressure at the end of a release review is how a calibrated model
becomes an uncalibrated one.

**Why it is nonetheless a real risk, stated plainly.** The axis passes today but **not
robustly**: sampling half-width is ~0.08 at 6,000 hands against a margin of 0.042, so a
future seed can flip it. This is a latent flaky test, and the release brief's rule is that an
intermittent failure is a defect until explained. It IS explained — cause localised,
mechanism understood, monotone relationship measured — which is why it is a recorded
limitation rather than an open mystery. The per-profile margin and both trait values now
print on every row, so if it does flip, the output says why.

## REM-2 — P3 — three declared axes are one-sided across all twelve profiles

`pfrShareOfVpip` +0.0422 (0/12 below, tolerance 0.08), `bluffFrequency` +0.0571 (0/12,
tol 0.20), `betSizingPreference` −0.0410 (12/12, tol 0.18). All comfortably inside tolerance,
so nothing fails — but a consistent one-sided bias on twelve independent profiles is a signal,
not noise. `pfrShareOfVpip` is algebraically downstream of `vpip` (+0.0132) and `pfr`
(+0.0250), both one-sided up from a documented positional-opportunity imbalance.

The fixer **deliberately did not add directional bands for these three**, on the grounds that
*"any band I wrote today would be fitted to the value it had to admit."* That is the right
call and is recorded here rather than in a test, because a test fitted to today's measurement
does not detect drift — it certifies it. The axes are named in the test header so the omission
is visible to the next reader. Directional bands ARE asserted, at half-tolerance, for `vpip`,
`aggressionFrequency`, `threeBetTendency` and `foldToPressure`.

## REM-3 — P2 — no browser harness exists in CI

The two tests that would actually catch the frontend P0 and P1 in this review — a viewport
occlusion hit-test and a keyboard focus-trap walk — cannot run in CI, because there is no
browser harness. Both defects were found and verified by driving a real browser over CDP, and
the probes exist in the session scratchpad, but nothing in the repository re-runs them.

Consequence, stated honestly: `pnpm run test:a11y` is a STATIC audit of server-rendered HTML
(its own header says so), and `packages/ui/test/layout-guarantees.test.ts` asserts CSS
properties textually. Neither can observe that one element covers another, which is precisely
what the P0 was. The class of defect remains undetectable by the automated suite.

## REM-4 — P2 — with JavaScript disabled, every route renders the loading skeleton permanently

The real markup ships in the streaming payload and needs React's inline `$RC` swap, so with
scripting off the Suspense fallback in `app/loading.tsx` is all a reader ever gets. The
adjacent case — scripting ON but the bundle failing — IS now handled, by CSS deadlines that
force the boot overlay hidden and unrevealed sections visible at 900ms.

This matters for this product specifically: the lessons, glossary and scenario write-ups are
ordinary prose with no reason to require JavaScript.

## REM-5 — P3 — WebSocket heartbeat termination is untested

`WS_LIMITS.heartbeatIntervalMs` is 15s and the hub's interval takes no injectable clock, so a
real test of "socket dies after two missed pings" would add 30+ seconds to every run. Closing
it needs a seam in `apps/api/src/ws/hub.ts`. Recorded rather than faked with a mock that would
assert the mock's behaviour instead of the hub's.
