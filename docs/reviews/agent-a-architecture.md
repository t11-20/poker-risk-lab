# Agent A — Architecture & Integration review

**Reviewer:** Agent A (independent). I did not write this code.
**Date:** 2026-08-18
**Scope:** module boundaries, Next/Fastify separation, contracts, persistence, WebSockets and the
table actor, reconnect/idempotency, error handling, dead code, graceful shutdown.

**Verdict: FAIL — do not ship.**

The server is the strong half of this repo. `apps/api`, `@prl/poker-engine`, `@prl/poker-math`
and `@prl/poker-ai` are careful, well-tested, and the seams I attacked mostly held. The failure is
at the **web ↔ API seam**: `apps/web` is not connected to the API at all. Every REST path it
requests 404s, it never opens a WebSocket, and because its fallback logic treats 404 as
"API unavailable", all of this fails *silently* into fixture data. The result is that the shipped
front end is a static prototype in front of a working server.

Two P0s, one P1, three P2s, five P3s. Details and reproductions below.

---

## Baseline — what I ran, and what it did

Everything below was run by me from a clean state against the running stack
(API `127.0.0.1:3001`, web `127.0.0.1:3000`, PostgreSQL 16 in Docker, migrated and seeded).

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | PASS — `Already up to date`, exit 0 |
| `pnpm run typecheck` | PASS — 8 projects, exit 0 |
| `pnpm run lint` | PASS — exit 0, 2 warnings (cognitive complexity, `packages/content/src/validate.ts:670,865`) |
| `pnpm run build:packages` | PASS — exit 0 |
| `pnpm run build` | PASS — exit 0, 14 web routes emitted |
| `pnpm run test` | PASS — `tests 357 / pass 356 / fail 0 / skipped 1` |
| `pnpm run test:smoke` | PASS — 37 checks (the brief says 36; harmless drift) |
| `pnpm run db:verify` | PASS — 121 columns, 41 indexes, 13 tables checked |
| `apps/api` tests with `DATABASE_URL` set | PASS — `tests 78 / pass 78` (the 6 Postgres suites that skip without it) |
| SIGTERM with a warm worker pool | PASS — clean exit, no orphaned process |

Builds and typechecks are clean from a clean state. I found nothing that fails to compile.

### Note on the working tree

Three files are **not part of the release and are not mine**:

```
./packages/poker-ai/test/zz-review-probe.test.ts     18 Aug 00:47
./packages/poker-ai/test/zz-review-quality.test.ts   18 Aug 00:55
./packages/poker-ai/test/zz-review-stats.test.ts     18 Aug 00:51
```

Every other file in that directory is timestamped 00:38 or earlier. These are another reviewer's
probe files written into the repo during this session. Per my instructions I did not read them.
They are picked up by `@prl/poker-ai`'s `test/*.test.ts` glob, so **the `357` figure above is
contaminated**. Excluding them, `@prl/poker-ai` is `tests 137 / pass 137 / fail 0`. They must be
deleted before release.

---

## P0 — release blockers

### P0-1. Every REST path `apps/web` requests omits the `/api/v1` prefix, so the entire web app silently runs on fixtures

**Location**
- `apps/web/src/lib/api.ts:306` — `'/api/session'`
- `apps/web/src/lib/learn-data.ts:41-43` — `'/api/content/lessons'`, `'/api/content/lessons/:id'`, `'/api/content/glossary'`
- `apps/web/src/lib/legends-data.ts:48-51` — `'/api/legends/profiles'`, `'/api/legends/:profileId/learn'`, `'/api/legends/compare'`, `'/api/legends/hands/:handId/comparison'`
- `apps/web/src/app/lab/page.tsx:100` — `'/api/scenarios'`
- `apps/web/src/app/lab/[scenarioId]/page.tsx:47` — `'/api/scenarios/:id'`
- `apps/web/src/app/review/page.tsx:126` — `'/api/hands?…'`
- `apps/web/src/app/review/[handId]/page.tsx:41` — `'/api/hands/:handId'`

`API_PREFIX = '/api/v1'` (`apps/api/src/app.ts:55`). No path in the web client includes it. The
content paths are wrong twice over — they also omit the `/content` segment.

**Problem**

Every one of these 404s. `isApiUnavailable()` (`apps/web/src/lib/api.ts:96`) returns `true` for
`status === 404`:

```ts
if (error.code === 'transport') return true;
if (error.code === 'service_unavailable') return true;
return error.status === 404 || error.status === 501 || error.status >= 502;
```

so every screen takes its "the API is not deployed yet" branch and renders a bundled fixture. No
error, no warning, no failed build, no failing test. `next.config.ts` has no rewrites — its header
states "Deliberately absent: any webpack or turbopack customisation, any redirect" — so nothing
repairs the paths at runtime.

**Reproduction**

```
$ check() { ws=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3001$1"); \
            cs=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3001$2"); \
            printf "%-30s -> %s   | %-28s -> %s\n" "$1" "$ws" "$2" "$cs"; }

/api/session                   -> 404   | /api/v1/auth/session         -> 200
/api/content/lessons           -> 404   | /api/v1/content/lessons      -> 200
/api/content/glossary          -> 404   | /api/v1/content/glossary     -> 200
/api/scenarios                 -> 404   | /api/v1/content/scenarios    -> 200
/api/legends/profiles          -> 404   | /api/v1/legends/profiles     -> 200
/api/hands                     -> 404   | /api/v1/hands                -> 401
```

**Evidence — the user-visible consequence**

The API serves 36 scenarios (`test:smoke`: `scenarios served  36 scenarios`). The running web app
serves 6, and they are a *different, disjoint set* of ids:

```
$ curl -s http://127.0.0.1:3000/lab | grep -o 'href="/lab/[a-z0-9-]*"' | sort -u
href="/lab/flop-flush-draw-price"
href="/lab/flop-spr-commitment"
href="/lab/preflop-set-mining-odds"
href="/lab/preflop-squeeze-fold-equity"
href="/lab/river-bluff-catch-range"
href="/lab/turn-gutshot-price"
```

None of those six exists in `packages/content/data/scenarios/`. The requirement is "a Scenario Lab
with 30+ scenarios"; the shipped app has 6.

The page tells the reader so, in developer language:

> **Fixture data** The scenario API is not reachable, so this list comes from the typed fixture in
> `src/fixtures/scenarios.ts`. Every figure in it was computed by the real analysis functions, but
> no server was involved in this page.

Lessons are worse. `/learn` lists all 17 (the summaries fixture is complete), but only 8 full
lesson bodies are bundled. Opening any of the other 9 renders a dead end:

```
$ curl -s http://127.0.0.1:3000/learn/bet-sizing   # 200
… "Watch out — This lesson's text is not available in this build. The content service is not
reachable and this lesson's body is not in the bundled copy, so there is nothing to show you.
It is a gap in the deployment rather than a missing lesson…"
```

The 9 unreachable lessons: `betting-actions`, `blinds-and-the-option`, `position-basics`,
`all-ins-and-side-pots`, `reading-the-board`, `bet-sizing`, `ranges-and-combos`, `variance`,
`tournament-chips-and-icm`. Between them they carry blinds, position, actions, all-ins and side
pots, bet sizing, ranges, variance and ICM — most of the required syllabus.

Also broken beyond a missing prefix: `legends-data.ts:49` calls
`/api/legends/:profileId/learn`, but the server's route is
`GET /api/v1/legends/profiles/:profileId` — a different path *shape*. It returns exactly
`LearnFromProfileResponse` (`profileId, disclosure, learnFrom, counterStrategy, observed,
contrasts`), so fixing the prefix alone will not fix this one.

**Fix**

Introduce one exported constant (`export const API_PREFIX = '/api/v1'`) in `apps/web/src/lib/api.ts`
and build every path from it, or prepend the prefix inside `call()` so no call site can forget it.
Correct `/api/scenarios*` → `/api/v1/content/scenarios*` and
`/api/legends/:id/learn` → `/api/v1/legends/profiles/:id`. Separately, stop treating a bare `404`
as "API unavailable" — that is what turned a wiring bug into a silent one. A 404 on a path the
client constructed is a client bug and should be loud in development.

**Missing test**

An integration test that asserts every path constant the web client can emit resolves to a
registered route on a real `buildApp()` instance — i.e. drive `app.inject()` at each of
`LEARN_API_PATHS`, `LEGEND_API_PATHS`, `fetchSession`'s path and the four inline template paths,
and assert none returns 404. This is a pure-Fastify test needing no browser, and it would have
failed on day one.

---

### P0-2. `/play` never opens a WebSocket — guided bot play and private multiplayer are not wired to the server

**Location** `apps/web/src/app/play/page.tsx`, `apps/web/src/components/TableStage.tsx:115`,
`apps/web/src/fixtures/table.ts`

**Problem**

There is no WebSocket client anywhere in `apps/web`. Searching the whole tree for a socket
constructor returns only prose in comments:

```
$ grep -rIn "WebSocket\|EventSource\|socket" apps/web/src --include=*.ts --include=*.tsx \
    | grep -vi "websocket contract\|WebSocket that will feed\|the WebSocket"
apps/web/src/app/play/page.tsx:12:  * screen renders from `src/fixtures/table.ts` … the day the socket
apps/web/src/app/play/page.tsx:131: * "no server" means in code; this is the same fact stated for a reader. It goes when the socket
apps/web/src/fixtures/table.ts:10:  * socket lands, the only change is where the object comes from.
```

`/play` renders from `src/fixtures/table.ts`, with `?state=` selecting one of four static fixtures.
`TableStage`'s `onAct` is optional (`TableStage.tsx:115`) and is not supplied by the page, so
submitting a decision "disables the controls and says plainly that nothing was sent".

The server side is complete and tested — `ws/hub.ts`, `ws/router.ts`, `rooms/table.ts`,
`rooms/bots.ts`, with 357-test coverage including handshake close codes, frame limits,
per-recipient redaction and reconnect. None of it is reachable from the product.

**Reproduction**

```
$ curl -s http://127.0.0.1:3000/play | grep -c "prl-play"      # renders
$ grep -rn "new WebSocket" apps/web/src | wc -l
0
```

**Evidence** `apps/web/src/app/play/page.tsx:11-14`:

> The API and the WebSocket that will feed this route are being built in parallel with it. So the
> screen renders from `src/fixtures/table.ts`, typed against the real contract, and the day the
> socket lands the only change is where the object comes from.

That day has not come. The required features "guided bot play", "private invite-only multiplayer",
"an immersive table" and "a premium Coach panel" are, in the shipped app, static fixtures.

**Fix**

Implement the socket client: connect to `ws://<api>/api/v1/ws`, send `hello` with
`PROTOCOL_VERSION`, render from the `WsEvent` state frames, and wire `TableStage`'s `onAct` to a
`submitAction` frame carrying a client-generated `actionId` and the `expectedSequence` from the
current view. The server contract for all of this already exists in
`packages/contracts/src/ws-protocol.ts` and is exercised by `apps/api/test/ws-router.test.ts`.

**Missing test**

An end-to-end test that opens a real socket against a running API, plays one hand to completion
against a bot, and asserts the client rendered the server's terminal state — plus a narrower unit
test that `/play` supplies `onAct` (i.e. that the live path, not the fixture path, is the default).

---

## P1 — serious

### P1-1. `consistentWithAnalysis` is implemented twice with different tolerances; the learner sees one verdict and the database records the other

**Location**
- Server: `apps/api/src/routes/content.ts:131` and `:740`
- Client: `apps/web/src/lib/consistency.ts:50` and `:116`
- Consumer: `apps/web/src/components/ScenarioStage.tsx:187-188`

**Problem**

The server's margin scales with the stakes — one big blind:

```ts
const CONSISTENCY_MARGIN_BIG_BLINDS = 1;            // content.ts:131
const margin = CONSISTENCY_MARGIN_BIG_BLINDS * Math.max(1, bigBlind);   // content.ts:740
```

The client's is a flat five units, independent of the big blind:

```ts
export const CONSISTENCY_TOLERANCE_UNITS = 5;       // consistency.ts:50
consistent: gapUnits !== null && gapUnits <= CONSISTENCY_TOLERANCE_UNITS,   // consistency.ts:116
```

These disagree in both directions. At `bigBlind: 2` the server's margin is 2 units and the
client's is 5, so an action 4 units off the best-valued row is **inconsistent** to the server and
**consistent** to the learner. At `bigBlind: 10` the server allows 10 and the client 5, so an
action 7 units off is **consistent** to the server and **inconsistent** to the learner.

Worse, `ScenarioStage.tsx:187-188` *always* judges locally and never reads
`ScenarioAttemptResponse.consistentWithAnalysis`:

```ts
? judgeConsistency(analysis, committed.action)
: judgeConsistency(analysis, committed.action, committed.to);
```

So the verdict shown on screen is the client's, while the verdict the server persists to
`scenario_attempts.matched_expected` is its own. The product can tell a learner their decision was
consistent and record the opposite.

**Reproduction** By inspection of the two constants above; both are reachable today. Note that
`consistency.ts`' own header claims the shared-module rationale — "Two copies of a rule about what
counts as consistent would eventually be two different rules" — which is precisely what has
happened, across the package boundary rather than within it.

**Evidence** The two constants quoted above, plus `ScenarioStage.tsx:187-188` showing the server's
answer is never consulted.

**Fix** One rule, one place. Move the tolerance into `@prl/poker-math` (or `@prl/contracts`, which
both sides already depend on) as a pure function of the report and the big blind, and have both
`content.ts` and `consistency.ts` call it. Then have `ScenarioStage` prefer the server's
`consistentWithAnalysis` when a live response is available, falling back to the shared function
only when it is not.

**Missing test** A shared-fixture test that runs the same `CoachReport` + action + big blind
through the server's `consistencyOf` and the client's `judgeConsistency` and asserts the two
`consistent` booleans are identical, across a table of big blinds (1, 2, 10, 50) and EV gaps
(0, 1, 3, 5, 11).

---

## P2 — moderate

### P2-1. Seven of the twelve Legend profiles cannot be persisted; hand history cannot attribute a seat to a Legend at all

**Location**
- `db/migrations/0001_initial.sql:454-460` — the `room_members_bot_profile_allowed` CHECK
- `apps/api/src/rooms/bots.ts:167-190` — `LEGACY_PROFILE_IDS`, `persistableProfile`
- `db/migrations/0001_initial.sql:640-667` — `prl.hand_seats` has no profile column
- `packages/contracts/src/api-types.ts:407-416` — `HandReviewSeat` has no profile field

**Problem**

`room_members.bot_profile` admits only six values:

```sql
bot_profile IN ('nit','tight-aggressive','loose-aggressive','calling-station','maniac','unknown')
```

`persistableProfile()` reverse-maps the five profiles that have a legacy alias and returns
`'unknown'` for everything else. Five of the twelve profiles round-trip; the other seven do not.
`hand_seats` has no profile column at all, and `HandReviewSeat` has no profile field, so once the
in-memory registry is gone (restart, or room closed) nothing can say which Legend held a seat.

The requirements ask for "Post-hand comparison", "what can I learn from this player" and "replay
commentary" — all of which need to know which profile played.

**Reproduction**

```
$ # profiles with a legacy alias round-trip, remapped:
$ curl … -d '{"profileIds":["patient-technician","volume-grinder"], …}' /api/v1/legends/matches
$ psql -c "select seat, bot_profile, u.display_name from prl.room_members m join prl.users u …"
 seat |   bot_profile    |    display_name
------+------------------+--------------------
    1 | tight-aggressive | Patient Technician
    2 | maniac           | Volume Grinder

$ # profiles without one do not:
$ curl … -d '{"profileIds":["vocal-aggressor","adaptive-exploiter","range-narrator"], …}' …
 seat | persisted |    display_name
------+-----------+--------------------
    1 | unknown   | Vocal Aggressor
    2 | unknown   | Adaptive Exploiter
    3 | unknown   | Range Narrator
```

Meanwhile the live API reports the true ids for the same room, from memory only:

```
 seat 1 isBot True botProfile patient-technician name Patient Technician
 seat 2 isBot True botProfile volume-grinder     name Volume Grinder
```

**Evidence** The CHECK, the `persistableProfile` fallback (`return 'unknown'`,
`bots.ts:189`), and the psql output above. `bots.ts:163-165` acknowledges it:
"A Legends profile seated at a table is persisted as `unknown`, because the CHECK does not know
these ids and changing a CHECK is a migration and a review, not a convenience."

That reasoning is sound about *process* but it leaves the feature broken. Note also that
`tight-aggressive` is a lossy alias: it is the persisted value for `patient-technician`, so a
legacy `tight-aggressive` bot and a Legends `patient-technician` bot are indistinguishable in the
database.

**Fix** A migration that widens the CHECK to the twelve real profile ids (keeping the five legacy
names for existing rows, or migrating them), plus a `bot_profile` column on `hand_seats` written at
hand start, plus a profile field on `HandReviewSeat`. Then delete `persistableProfile`.

**Missing test** A repository test that seats each of the twelve profiles in turn, reads the row
back, and asserts `bot_profile` equals the id that was seated — and a hand-review test asserting
the profile survives a registry that has been discarded.

### P2-2. `buildHandComparison` has no server caller, so post-hand comparison is unreachable

**Location** `packages/poker-ai/src/comparison.ts:484` (exported), `packages/poker-ai/src/index.ts:50`

**Problem** The pure implementation exists and is heavily tested. No route calls it:

```
$ grep -rn "buildHandComparison" apps/api/ | grep -v dist
NO -- apps/api never calls buildHandComparison
$ grep -rn "HandComparison\|ComparedDecision" apps/api/src
(no matches)
```

The web client expects `GET /api/legends/hands/:handId/comparison`
(`legends-data.ts:51`). No such route exists at any prefix:

```
/api/v1/legends/hands/hnd_x/comparison  -> 404
```

The API's only legends routes are `/legends/profiles`, `/legends/profiles/:profileId`,
`/legends/matches`, `/legends/compare`. `HandComparison` is a contract type with no producer.

**Evidence** The greps above, plus `apps/web/src/components/PostHandComparison.tsx:457` consuming a
`HandComparison` that only a fixture can supply.

**Fix** Add the route: load the hand, build per-decision analysis as `review/build-review.ts`
already does, and call `buildHandComparison`. It also needs P2-1 fixed, since it must know the
profile.

**Missing test** A route test asserting `GET /api/v1/legends/hands/:handId/comparison` returns a
`HandComparison` for a hand the caller played, and 404 for one they did not.

### P2-3. CI never runs `test:smoke`, `db:verify`, `security:hygiene` or `design:contrast`

**Location** `.github/workflows/ci.yml`, `.github/workflows/supply-chain.yml`

**Problem** Four scripts that exist as release gates are in no workflow:

```
$ grep -n "smoke\|db:verify\|verify-schema\|security:hygiene\|design:contrast\|check-contrast" .github/workflows/*.yml
NO MATCHES for smoke/db:verify/hygiene/contrast in any workflow
```

`db:verify` "asserts the LIVE schema security properties" — the check that would catch a migration
introducing a deck or salt column, or over-broad `prl_app` privileges. `test:smoke` is the only
end-to-end check that the API's 37 documented behaviours hold. Both pass today; neither is
enforced. The `a11y` job already brings up Postgres, migrates and seeds, so `db:verify` costs one
line there.

Note that neither of these would have caught P0-1 or P0-2 — `test:smoke` drives the API directly
with correct paths and never exercises the web client. That gap is what P0-1's missing test covers.

**Evidence** The grep above; the workflow's own jobs are `supply-chain`, `lint`, `typecheck`,
`test`, `exhaustive`, `build`, `a11y`.

**Fix** Add `pnpm run db:verify` to the `test` job after `db:migrate`, add `security:hygiene` to
the `supply-chain` job, add `design:contrast` to `lint`, and add a job that boots the API and runs
`test:smoke`.

**Missing test** N/A — this *is* the missing test wiring.

---

## P3 — polish

### P3-1. `apps/web` declares `@prl/content`, which the architecture doc forbids, and never imports it

`apps/web/package.json:14` declares `"@prl/content": "workspace:*"`. `docs/ARCHITECTURE.md:81`
lists the web app's allowed dependencies as `contracts`, `ui`, `poker-math` and its forbidden ones
as "import `@prl/content`, or compute anything authoritative". `@prl/content` reads JSON with
`node:fs` (`packages/content/src/index.ts:28`) and is server-only.

No web source imports it — only comments mention it — so nothing breaks today. But the declaration
is what makes a future accidental import resolve silently, which is the failure the boundary exists
to prevent. Remove it.

Conversely, `apps/web` **does** import `@prl/poker-engine`
(`CommitmentVerifier.tsx:73-74` for `verifyDeckReveal`, plus `scenario-view.ts`,
`learn-calculations.ts`, `hand-replay.ts` for `parseCards`/`positionLabels`). That is legitimate —
client-side commitment verification is a stated requirement — but the doc's table does not list it
as allowed. Update the table.

**Missing test** A boundary test that reads each `apps/*/package.json` and asserts its dependencies
are a subset of the set `docs/ARCHITECTURE.md` declares, so the doc and the manifests cannot drift.

### P3-2. Every unknown route answers `content_not_found` — "That lesson, quiz or scenario does not exist."

`apps/api/src/errors.ts:401-403` and `:240` map all 404s to `content_not_found`, whose message is
`packages/contracts/src/errors.ts:159`: "That lesson, quiz or scenario does not exist."

```
$ curl -s http://127.0.0.1:3001/                 # and /admin, /healthz, /api/v1/zzz
{"error":{"code":"content_not_found","message":"That lesson, quiz or scenario does not exist.",…}}
```

The *code* choice is deliberate and well argued (a distinguishable "route exists, id does not"
would map the API surface). The *copy* is not: it is factually wrong for `/`, for `/admin`, and for
an unknown hand or room — and `hand_not_found` and `room_not_found_or_not_permitted` already exist
with correct messages, so the wording is gratuitously specific. Give `content_not_found` a neutral
message ("That resource does not exist.") or add a generic `not_found` code for the route-level
handler.

**Missing test** Assert `GET /` and `GET /api/v1/<unknown>` return a message that does not name
lessons, quizzes or scenarios.

### P3-3. `HandReviewResponse.reveal` is typed `unknown` in the contract

`packages/contracts/src/api-types.ts:397`: `readonly reveal: unknown;` — for the Merkle reveal,
the payload whose verification is the product's entire fairness argument. `@prl/contracts` already
depends on `@prl/poker-engine`, which exports `DeckReveal`, so the type is available.

This is defended rather than sloppy: `CommitmentVerifier.tsx:155-190` re-parses the value
field by field before trusting it, which is correct for data off the wire. But the contract should
still say `DeckReveal` so a client gets compile-time help, with the runtime parser kept as the
trust boundary.

**Missing test** A type-level assertion that `HandReviewResponse['reveal']` is assignable to
`DeckReveal`.

### P3-4. Stale module documentation asserts that shipped modules do not exist

`apps/web/src/fixtures/learn.ts:6-7`: "`apps/api/src/routes/content.ts` does not exist yet —
another team is writing it." It exists and is 1,074 lines. Same pattern in
`apps/web/src/fixtures/table.ts:6` and `legends-data.ts:19` ("`LEGEND_API_PATHS` is provisional:
the routes are the API team's to name").

These comments are why P0-1 reads as intentional. They should be deleted with the fix, and their
survival is a signal that the fixtures were never revisited after the API landed.

### P3-5. Dead exports

`apps/web/src/fixtures/session.ts` exports `FIXTURE_USER`, `FIXTURE_SESSION` and
`ANONYMOUS_SESSION`; only `STARTING_UNITS` is imported anywhere
(`apps/web/src/app/layout.tsx:74`). Remove the three, or wire them into the session fallback that
P0-1's fix will need.

---

## Checked and found sound

Recording these so the next reviewer does not redo them.

1. **`@prl/poker-engine` purity.** No `fs`, `http`, `Date.now`, `new Date`, `performance.now` or
   `Math.random` anywhere in `src/`. Only `node:crypto` (`randomFillSync`, `createHash`) — builtins,
   not dependencies, and required by the CSPRNG guardrail. Manifest declares zero runtime
   dependencies, which is accurate. The one `process.env` read (`rng.ts:159`) is the production
   guard on the deterministic test generator, which is the right direction. Module-level state is
   two immutable lookup `Map`s in `cards.ts`.
2. **`@prl/poker-math` purity.** Two `performance.now()` calls, used only to populate
   `elapsedMs` in a result (`equity.ts:331,403,514,550`) — they do not affect any computed figure.
   Module state is one memoised strength table (`hand-ranking.ts:240`) and one immutable rank map.
3. **Undeclared imports.** None. My first scan produced false positives by matching template
   literals containing poker range notation; a corrected scan found every non-builtin import
   declared. In particular `ws`/`@types/ws` in `apps/api` look unused but are load-bearing —
   `apps/api/tsconfig.json:8-24` documents that `@fastify/websocket`'s own `.d.ts` does
   `import * as WebSocket from 'ws'` and cannot resolve types from the isolated store without the
   `paths` mapping. I nearly filed this as a finding; it is correct as written.
4. **`additionalProperties: false` is genuinely enforced**, not merely declared. Ajv is configured
   `removeAdditional: false` (`app.ts:125`) so unknown fields are rejected rather than stripped:
   `POST /api/v1/auth/guest` with `{"displayName":"Zed","isAdmin":true}` →
   `{"code":"invalid_request","fields":{"isAdmin":"is not a field this endpoint accepts"}}`.
   Schemas are attached to (not merely defined for) every route that takes a body, query or params.
   `routes/progress.ts` has none, correctly — its routes take no input.
5. **Contract conformance.** `SessionResponse`, `CreateGuestResponse`, `RoomSummary`,
   `RoomListResponse`, `LegendProfilesResponse` and `LearnFromProfileResponse` matched their
   contract types field for field on live responses.
6. **The table actor is a real serialisation point.** `rooms/table.ts` contains no `await` and no
   `async` method; `sit`, `stand`, `startHand`, `submitAction` and the timer expiry all route
   through `enqueue()` (`table.ts:325-331`), which chains on `this.queue` and swallows the
   rejection on the chain while returning it to the caller — so one `illegal_action` cannot wedge
   the table. Since the queued work is synchronous, it is atomic with respect to the event loop. I
   could not construct an interleaving.
7. **Idempotency and staleness.** The memo is checked before any legality check (`table.ts:41-56`),
   which is the right order. `apps/api/test/rooms.test.ts:374-406` is a genuine test, not a
   regression lock: it asserts `deduplicated === true`, that `appliedSequence` equals the original,
   and that neither `actionSequence` nor `potTotal` moved. The partial unique index
   `hand_actions_client_action_id_key ON (hand_id, action_id) WHERE action_id IS NOT NULL` exists
   live and backs it across processes.
8. **Seating races.** `room_members_live_seat_key ON (room_id, seat) WHERE left_at IS NULL` exists
   live, the DB is the arbiter (`registry.ts:634-638`), the unique violation is translated to
   `seat_taken` (`repositories/sql.ts:228`), and a table refusal compensates by releasing the DB
   seat (`registry.ts:648-660`). No check-then-write.
9. **No deck or salt is persisted.** `db:verify` passes; `apps/api/test/repositories.test.ts` has
   "has no column for the deck or the salts, and this proves it"; a source scan asserts no SQL names
   a deck or salt column. The repository SQL matches the live schema — all 78 Postgres-backed tests
   pass against the running database.
10. **Error handling leaks nothing.** Eleven hostile calculation payloads (`null`/`1e999` samples,
    duplicate hero card, hero card also on the board, unicode range, `top:0`, `top:-5`, six
    opponents, negative pot, street/board mismatch) were all rejected as `invalid_request` with
    field-level messages derived from the schema. No stack, no SQL, no internal message. "Not found"
    and "not permitted" are deliberately indistinguishable for rooms
    (`room_not_found_or_not_permitted`, 404), confirmed by smoke check "an uninvited user gets 404,
    not 403".
11. **Route manifest.** All 7 entries in `EXPECTED_ROUTE_MODULES` (`app.ts:74-82`) exist and are
    registered via `API_ROUTE_MODULES` (`routes/index.ts:67-75`). The previously-fixed session-scope
    bug holds: `/hands`, `/me/progress` and `/rooms` all answer `not_authenticated`, not
    `internal_error`. The registry is constructed with `postgresArchive` before any module can ask
    for it.
12. **Graceful shutdown.** Verified on a second instance on port 3099 with a warm pool (16 threads
    after a 200k-sample Monte Carlo): SIGTERM → `"shutting down"` → `"shutdown complete"` → exit,
    ~3 ms, no orphaned process or child. `closeSharedPool` is registered `onClose` from both
    `calc.ts:119` and `content.ts:921` and is idempotent; the WS hub clears its heartbeat and closes
    sockets (`hub.ts:228-234`); `rooms.ts:229` closes the registry it owns.
13. **No unfinished work.** Zero `TODO`, `FIXME`, `HACK`, `XXX`, `.only(`, `skip(` or `todo(` in
    source or tests. Zero broad `any` — the only matches are the words "any"/"anything" in prose and
    one comment stating `as any` is banned. No commented-out assertions.

---

## Could not verify

1. **Whether a worker thread leaks on task timeout.** I could not force a Monte Carlo run to exceed
   `coachTimeoutMs` from outside — the server clamps sample counts, and a 200k-sample run finished
   in 3.8 s inside the budget. By inspection the path is correct: `expire` → `cancel` → `discard` →
   `terminate()`, with a `dead` WeakSet preventing double-decrement of `workerCount`
   (`pool.ts:449-513`). Needs a unit test with an injected `workerUrl` pointing at a script that
   spins, asserting `stats().workers` returns to its prior value.
2. **Multi-process idempotency and seating.** Both rely on partial unique indexes, which I
   confirmed exist live and are translated correctly, but I exercised them only within one process.
   A two-process test would be needed to prove the cross-process guarantee.
3. **Reconnect under real network loss.** `apps/api/test/ws-router.test.ts` covers "gives a
   reconnecting socket the current view with no catch-up protocol" at the router level, and I read
   the assertion. I could not exercise it end to end because there is no WebSocket client (P0-2).
4. **Whether P0-1's fix reveals further contract mismatches.** With every path 404ing, no web
   screen has ever rendered a real API response. Field-level conformance for
   `ScenarioResponse`, `LessonResponse` and `HandReviewResponse` as the *web components* consume
   them is therefore untested. Expect a second round of integration defects once the paths are
   fixed.
5. **`pnpm run test:exhaustive`, `test:a11y`, `test:load`, `db:setup`.** Out of my scope (Agent A);
   not run.
