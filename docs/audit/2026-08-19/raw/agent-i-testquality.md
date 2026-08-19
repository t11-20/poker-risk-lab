# Reviewer I — Test Quality

**Auditor:** Reviewer I (Test Quality). Did not author this codebase. Did not read `docs/audit/*` as evidence. Did not modify repository source.

**HEAD:** `f20bbad` (`f20bbad2f082e9fe135ce98070da16eff7cc3f14`)  
**Date:** 2026-08-19  
**Workspace:** `/Users/terence/Projects/exploration-sites/poker-risk-lab`

## Method

1. Inventory of every `*.test.ts` / `*.test.mjs` file and every `package.json` `test*` script.
2. Repo-wide search for `it.skip` / `describe.skip` / `test.skip` / `.only` / `xtest` / `TODO` / `FIXME` / `HACK` / `@ts-ignore` / `as any` / empty `catch` / `assert.ok(true)`.
3. Direct reading of assertions in engine invariants, evaluator, hidden-information, Coach, EV/odds identities, auth/session, WebSocket hub, migrations, reachability/database guards, CI workflows.
4. Mutation experiments in `/tmp` (copies only). Corresponding test files run with `env -u NODE_TEST_CONTEXT node --test …` so the runner actually executed files.
5. Targeted live runs on unmodified source: `packages/poker-engine/test/evaluate.test.ts` twice, `packages/poker-math/test/odds.test.ts` twice, `pnpm run test:scripts` once.

**Not executed this audit:** full `pnpm run test`, `pnpm run test:exhaustive`, `pnpm run test:simulation`, `pnpm run test:a11y`, `pnpm run verify`. A passing suite elsewhere is not treated as evidence. Where a requirement needs that execution, the row is **UNVERIFIED**.

---

## Inventory

### Test files and declarations

| Location | `*.test.*` files | `test(` / `it(` declarations |
| --- | ---: | ---: |
| `apps/api` (incl. `scripts/migrate.test.mjs`) | 45 | 622 |
| `apps/web` | 16 | 126 |
| `packages/content` | 2 | 28 |
| `packages/contracts` | 1 | 15 |
| `packages/poker-ai` (incl. `test/simulation/`) | 10 | 171 |
| `packages/poker-engine` (incl. `test/exhaustive/`) | 13 | 135 |
| `packages/poker-math` | 13 | 247 |
| `packages/ui` | 12 | 242 |
| `scripts/supply-chain` | 9 | 83 |
| **Total** | **121** | **1669** |

Helpers (`test/helpers.ts`, `test/helpers/*.ts`, `test/support/*`, `reference-evaluator.ts`) are not counted as test files.

### Documented commands → what they actually run

| Root script | What it invokes | In `verify`? | In CI? |
| --- | --- | --- | --- |
| `pnpm run test` | `build:packages` + `test:unit` + `test:integration` + `test:scripts` | yes | job `test` |
| `test:unit` | `pnpm -r --filter "./packages/**" --filter @prl/web test` | via `test` | via `test` |
| `test:integration` | `@prl/api test` (`node --test --test-concurrency=1 'test/**/*.test.ts'`) | via `test` | via `test` |
| `test:scripts` | `node --test 'scripts/**/*.test.mjs' 'apps/api/scripts/*.test.mjs'` | via `test` | via `test` |
| `test:no-database` | unit + `@prl/api test:without-database` + scripts | no (waiver seed) | **refused** (`CI` set) |
| `test:exhaustive` | `@prl/poker-engine test:exhaustive` (`test/exhaustive/**`) | yes | job `exhaustive` |
| `test:simulation` | `@prl/poker-ai test:simulation` (`test/simulation/**`) | yes | job `simulation` |
| `test:a11y` | `scripts/a11y-audit.mjs` | yes | job `a11y` |
| `test:all` | `test` + exhaustive + simulation + a11y | via `verify` | split across jobs |
| `test:smoke` / `test:load` | live-server harnesses | **no** | job `end-to-end` |
| `security:audit` | eight supply-chain gates | yes | job `supply-chain` (needs-gate for every other job) |

Package globs are one-level where that is the exclusion mechanism:

- `@prl/poker-engine test` is `test/*.test.ts` — exhaustive lives in a subdirectory on purpose.
- `@prl/poker-ai test` is `test/*.test.ts` — simulation lives in a subdirectory on purpose.

`apps/api/test/workspace-test-reachability.test.ts` is the static guard that those globs, and every other `*.test.*` file, are reachable from `test` / `test:all` / `verify` / `test:no-database` / CI `pnpm run …` invocations.

---

## Requirement catalog

| ID | Requirement | Verdict | Evidence |
| --- | --- | --- | --- |
| TEST-001 | Documented root test command | **PARTIAL / EXECUTION UNVERIFIED** | `package.json` `"test"` is `build:packages && test:unit && test:integration && test:scripts`. Named in `README.md`, `docs/RUNBOOK.md`, `docs/VERIFICATION.md`. This audit did **not** run that command. Targeted runs: evaluate 15/15 ×2, odds 25/25 ×2, `test:scripts` 102/102. |
| TEST-002 | No disabled / skipped / todo / `.only` | **PASS** | Zero `it.skip` / `describe.skip` / `test.skip` / `xtest` / `xdescribe` / `.only` in executable positions. The only `describe.skip` / `it.todo` strings are comments and assembled fixtures inside the reachability guard. Conditional `{ skip: databaseSkip(...) }` / `{ skip: DB_SKIP_REASON }` / `{ skip: skipReason }` / `t.skip(reason)` exist; they are identifiers, not literal `'temporarily'`. |
| TEST-003 | Reachability guard prevents `tests 0` as success | **PASS (inspected)** | `apps/api/test/workspace-test-reachability.test.ts` refuses: non-`node --test` package scripts, empty globs, files with no `test()`/`it()`, literal `{ skip: '…' }`, `--test-only`. Negative controls spawn `node --test` on scratch files and assert node itself reports `tests 0`. Not re-run this audit. |
| TEST-004 | Database guard fails loudly when DB is absent | **PASS (inspected)** | `apps/api/test/database-availability.test.ts` + `test/helpers/database.ts`: if `probeSchema()` fails and `DATABASE_REQUIRED` (CI, or no waiver), `assert.fail` naming `db:setup`. Skip reason is **not** returned as a silent pass. Not re-run this audit against a dead DSN. |
| TEST-005 | Documented no-database waiver is honest | **PASS (inspected)** | `pnpm run test:no-database` → `@prl/api test:without-database` loads `apps/api/test/without-database.env` (`PRL_TESTS_WITHOUT_DATABASE=1`). Availability test allows skip only when waived **and** `CI` is unset; prints a process-exit banner that the run proved nothing about SQL. CI: `RUNNING_IN_CI && !DATABASE_REQUIRED` is asserted false. |
| TEST-006 | Suite reports what it executes | **PASS with note** | Live `test:scripts` printed `tests 102 / pass 102 / skipped 0`. API database skips log `skipping …: DATABASE_URL is not set…` / `console.info` per file. Node’s `{ skip: identifier }` **does** increment `skipped` (unlike literal `{ skip: 'x' }`, which node omits from the summary — that is why the reachability guard bans literals). |
| TEST-007 | Every `*.test.*` file reachable from a documented root | **PASS (inspected)** | 121 files map to a runner glob that `test` / `test:all` / `verify` / CI actually invoke. Exhaustive and simulation are **not** on `pnpm test`; they are on `test:all`, `verify`, and dedicated CI jobs. Reachability test seeds only those documented entry points plus CI `pnpm run` names. |
| TEST-008 | Deterministic across repeated runs (spot-check) | **PASS (spot-check)** | `evaluate.test.ts` 15/15 then 15/15 (durations 2669 ms / 2467 ms; 2 598 960-hand enumeration stable). `odds.test.ts` 25/25 then 25/25. Engine fuzz uses `createDeterministicRandomForTests`. Simulation suite claims byte-identical reproduction under a fixed seed (not re-run). Full-suite flake rate **UNVERIFIED**. |
| TEST-009 | No weak / vacuous assertions | **PASS with P2 notes** | No `assert.ok(true)`, no empty `deepEqual`, no sole `doesNotThrow` on a critical path. Satellite `assert.doesNotThrow` exists (equity min samples, format infinity, icm). Some floors (`files.length > 8`, `stats.scenarios >= 30`) are anti-empty guards, not correctness. See weak-inventory. |
| TEST-010 | No mock-only success paths billed as integration | **PASS with P2** | `@prl/api test` is the `test:integration` script. Many files (`auth.test.ts`, `rooms.test.ts`, `ws-router.test.ts`) drive `buildApp` against `Map` stores and say so in the header. They are **not** the only coverage: `coverage-session-conformance.test.ts` runs the same behaviours on Postgres; `coverage-room-store.test.ts` hits SQL; `ws-socket.test.ts` uses a real `ws` client over loopback (persistence still faked). Not a mock-only success path for the critical properties. |
| TEST-011 | Expected numbers independently derived | **PASS with P2 on equity band** | Odds/EV/Coach hand-worked closed forms (e.g. `7/44`, `1/3`, `9×4=0.36`). Evaluator frequencies are published combinatorial counts, plus a second algorithm in `reference-evaluator.ts`. **Gap:** `exactEquity` is never imported by a test file; AA vs KK is asserted as `0.80 < x < 0.84` in `apps/api/test/calc.test.ts` and as 75–88% in `scripts/smoke-test.mjs`, not as the published 81.946%. Coach `7/44` still pins exact enumeration on a different spot. |
| TEST-012 | No TODO/FIXME/HACK/XXX in tests that skip behaviour | **PASS** | Only hits are the reachability file’s prose and the `FIXTURE_NO_TESTS = '// TODO: write tests\n'` string used as a **negative** control. |
| TEST-013 | No broad `any` / `@ts-ignore` hiding failures | **PASS** | Zero `@ts-ignore` / `@ts-expect-error` / `as any` in tests or (from this search) production TS. A handful of `as unknown as CoachReport` / `WireView` / `Element` construct fixtures or JSON-walk results; they do not swallow assertion failures. |
| TEST-014 | No swallowed errors in source or tests | **PASS with P3** | No empty `catch (_) {}` in tests. Production `catch` blocks log, map to `AppError`, or send `internal_error`. Teardown `.catch(() => undefined)` on `sql.end({ timeout: 5 })` appears in helpers and coverage files. `apps/web/src/lib/theme.ts` embeds `catch(e){}` **inside the boot-script string** (localStorage), not as a test swallow. Session sliding-expiry catch logs a warning and continues — deliberate. |
| TEST-015 | Critical coverage — poker engine | **PASS (inspected; mutation-backed)** | Evaluator (incl. 2.6M five-card vs reference + published frequencies), pots with side-pot arithmetic, betting refusals, commitment, RNG source scan, 8 500-hand invariant fuzz with coverage floors, short-blinds, all-in runout, hidden-information, redaction-identity. Exhaustive 133 784 560-hand test exists and compares category counts to published totals (not re-run). Mutation 2 killed 4/15 evaluator tests including the 5-card exhaustive. |
| TEST-016 | Critical coverage — poker math / Coach | **PASS with P2** | Strong: `odds.test.ts` identities, `ev.test.ts` pot-odds seam, `outs.test.ts` counted cards, `coach.test.ts` hand-derived EV (the raise-charged-as-bet defect), `coach-legality.test.ts` vs engine `legalActions`, API `coach-legality.test.ts` through the worker pool. Weak: `packages/poker-math/test/equity.test.ts` is **only** Monte Carlo input validation (4 tests). `exactEquity(` does not appear in any test file. |
| TEST-017 | Critical coverage — auth / session | **PASS (inspected)** | `auth.test.ts`: inject() against a strict Map store (replay, expiry, CSRF). `oidc.test.ts`. `coverage-session-conformance.test.ts`: **same behaviour list on Map and Postgres**, plus equal HTTP transcripts. Cookie-name / secret tests. SQL half skips without DB; availability test fails the run instead. |
| TEST-018 | Critical coverage — redaction / hidden information | **PASS (mutation-backed)** | Engine JSON-walk + explicit `holeCards === null`. API `hidden-information-api.test.ts` (payload half always; HTTP half needs DB). WS `ws-socket.test.ts` scans every frame against ground-truth hidden cards. AI `no-hidden-information.test.ts` (Proxy read-set + pair of hands that differ only in hidden cards). Mutation 1 (always leak hole cards) failed 7/11 hidden-information tests and 6/7 redaction-identity tests. |
| TEST-019 | Critical coverage — WebSocket hub + live rooms | **PASS (inspected)** | `ws-socket.test.ts`: real upgrade, cookie session, hub, live table, bot, hidden-info over the wire, seat-reuse identity. `ws-router.test.ts`: recorder + real Ajv (no socket). `rooms.test.ts`: LiveTable + manual clock (Map store). `y2-ws-room-reopen.test.ts`, `y3-turn-clock.test.ts` (manual clock), `z1-settled-hand-invariants.test.ts` (chop is a legal zero-net). Persistence of rooms is faked in the socket tests. |
| TEST-020 | Critical coverage — migrations & DB tooling | **PASS (inspected)** | `apps/api/scripts/migrate.test.mjs`: `down` is a real refusing command, no DB required. `coverage-migrate-script.test.ts`, `coverage-verify-schema.test.ts` (throws away a database and **breaks** grants/columns so the gate is seen to fail), `coverage-postgres-archive.test.ts`, `w3-fixture-teardown-privileges.test.ts` (`prl_app` cannot DELETE rooms). Schema-breaking cases skip without admin DSN. |
| TEST-021 | Critical coverage — web client | **PARTIAL (P2)** | 16 files, all on `test:unit`. Runtime: `quiz-attempts.ts`, `isSignedOut`, `openTableSocket` with fake sockets, `tableReducer`. The majority are **source greps** (`honesty-claims`, `invite-codes`, `lesson-reads`, `y1-*`, `api-paths`, `app-shell-streaming`, `live-regions` markup). `apps/web` has no JSX transform / DOM; components are not rendered here. Live a11y of HTML is `test:a11y`, not this suite. |
| TEST-022 | Critical coverage — UI components | **PASS with P2** | Real SSR via `renderToStaticMarkup` + `loadComponent`: ActionBar, CardRow, CoachPanel (the 3 600% pairing). Pure functions: format, bet-sizing, probability guards, outs-count threshold pin against `@prl/poker-math`. CSS/text: `layout-guarantees.test.ts`, parts of `motion.test.ts`. No browser hit-testing (stated). |
| TEST-023 | Critical coverage — release-gating scripts | **PASS with P2** | Every `scripts/supply-chain/*.test.mjs` exists and `test:scripts` ran 102/102 here. `migrate.test.mjs` included. `harness-paths.test.ts` pins smoke/load URLs. **No unit tests** of `scripts/a11y-audit.mjs` or `scripts/check-contrast.mjs` themselves; those programs *are* the gates and CI runs them. |
| TEST-024 | Long-running suites are real evidence | **PASS (inspected; not re-run)** | Exhaustive: nested 7-loops over `DECK_SIZE`, `assert.equal(total, 133_784_560)`, nine published frequencies. Simulation: 8 000 hands/profile, z-tests, Spearman, cross-seed; independent counters in `declared-versus-observed.test.ts` that do not share `stats.ts` denominators. Invariant fuzz asserts showdown/fold/side-pot floors so a fold-only generator cannot pass. |
| TEST-025 | Named negative / failure-mode cases | **PASS** | Engine: illegal raise, wrong actor, NaN/negative bets, short deck, <2 players. Math: NaN/Infinity samples (hanging loop was the old defect), Coach illegal sizes, OddsError. Auth: expired/revoked/replay. Content: `scenario-coherence.test.ts` **reintroduces** shipped defects and asserts the validator fails. Schema verify: hostile ALTER/GRANT. Supply-chain: `--offline` must exit non-zero. Reachability: three bypasses built in `/tmp`. |
| TEST-026 | No flaky timing assumptions | **PASS with P2** | Turn clock and WS router use `createManualClock`. `z1-settled-hand-invariants.test.ts` exists because a “some stack moved” assertion flickered on chops. `shutdown.test.ts` uses 120–200 ms `setTimeout` to split an HTTP body around SIGTERM — timeout-to-fail (10 s / 15 s frame waits) is fine; sleep-to-arm is a residual flake surface. |
| TEST-027 | Mutation detection: ≥3 critical tests fail on a deliberate break | **PASS (executed)** | Three `/tmp` copies; three breaks; corresponding tests failed. Details below. |
| TEST-028 | Hard-coded probabilities justified or derived | **PASS with notes** | Content: situations, not answers; claims re-computed (`scenarios.test.ts`). Quiz `equity: 0.4` values are **inputs** to a named calculation, not stored answers. Web fixtures are generated copies of `buildCoachReport` / review output, locked by `web-fixture-figures.test.ts` and `legend-fixture-figures.test.ts` (remedy: `pnpm run fixtures:regenerate`). Exhaustive frequencies are published maths. |
| TEST-029 | verify / security:audit / a11y not skipped in CI | **PASS (inspected)** | `.github/workflows/ci.yml`: no `continue-on-error`, no `if: false`. `supply-chain` job runs `security:audit` then `security:hygiene`; every other job `needs: supply-chain`. Jobs exist for `test`, `exhaustive`, `simulation`, `a11y`, `lint`+`design:contrast`, `typecheck`, `build`, plus extra `end-to-end` and `containers`. `verify`’s gate list is a literal word list (so a `&&` chain cannot skip later gates). Scheduled `supply-chain.yml` re-runs the audit daily. |

---

## Mutation experiments

Copies only. Repository source untouched. `NODE_TEST_CONTEXT` unset (`env -u`) — leaving it set makes node print `run() is being called recursively… skipping running files` and report a green empty run; that is exactly the defect class TEST-003 is about.

### M1 — leak every hole card (`redactFor`)

**Break:** `/tmp/prl-mut-engine/src/redact.ts`  
`holeCards: maySeeCards ? seat.holeCards : null` → `holeCards: seat.holeCards`.

| File | Result |
| --- | --- |
| `test/hidden-information.test.ts` | **7 fail / 4 pass** / 11 |
| `test/redaction-identity.test.ts` | **6 fail / 1 pass** / 7 |

**Caught by (examples):**
- `a player view never contains another player's hole cards during play`
- `a spectator view shows nobody's hole cards`
- `seat 1 hole card Js leaked to viewer 0` (`assertNoHiddenCards`)
- `a hand that ends by folding reveals nobody's cards` (explicit `holeCards === null`)
- identity tests: `seat 1 (usr_a) exposed its cards to usr_c`

**Did not catch (and why — not vacuity):**
- `a hand won by folding reveals the board but NEVER the winner's cards` — asserts **Merkle `reveal.cards`**, not `PlayerView.holeCards`.
- `a hand that reaches showdown reveals the board and only the shown hands` — same, commitment proofs.
- `legal actions are only ever offered to the player whose turn it is` — different property.
- `cardsHiddenFrom accounts for every card…` — different function, not mutated.
- `the same deal with the players moved round gives each person the SAME two cards` — own cards still present.

The named isolation tests failed. A leak through `redactFor` is detected.

### M2 — never classify a flush (`evaluate`)

**Break:** `/tmp/prl-mut-eval/src/evaluate.ts` — deleted the `if (flushMask !== 0) return packTop(HAND_CATEGORY.flush, …)` return.

| File | Result |
| --- | --- |
| `test/evaluate.test.ts` | **4 fail / 11 pass** / 15 |

**Caught by:**
- `category ordering is strictly increasing` — `flush (549920) should beat straight (4456448)`
- `7-card hands pick the best five` — flush board classified as trips (`3 !== 5`)
- `EXHAUSTIVE: all 2,598,960 five-card hands match the reference evaluator` — **5 108 disagreements**, matching the published flush count
- `EXHAUSTIVE: full ordering agrees with the reference on a large random sample`

**Did not catch:** popcount, wheel-as-straight, 4-card reject, chop compare, 7-card brute-force sample that happened not to need a missed flush. Those tests are about other properties.

The 5-card exhaustive is independent of the production classifier: the reference evaluator is a different algorithm, and the frequencies are a published combinatorial result.

### M3 — pot odds uses the alpha formula

**Break:** `/tmp/prl-mut-math/src/odds.ts`  
`toCall / (pot + toCall)` → `toCall / (pot + 2 * toCall)` (the bettor’s alpha, the documented common mix-up).

`node_modules` of the copy was replaced with a symlink to the real package so `@prl/poker-engine` resolved.

| File | Result |
| --- | --- |
| `test/odds.test.ts` | **8 fail / 17 pass** / 25 |
| `test/ev.test.ts` | **2 fail / 39 pass** / 41 |

**Caught by (examples):**
- `a pot-sized bet lays 2 to 1, so the caller needs exactly one third` — got `0.25`, expected `1/3`
- `breakEvenEquity for a pot of 100 with 50 to call is exactly one third`
- `alpha is not the price the bet lays the caller`
- `calling at exactly the pot-odds break-even equity is worth exactly nothing` (the odds↔EV **seam**, derived by hand in `ev.test.ts`)

**Did not catch:** rule-of-2/4, hit-probability urn counts, MDF+alpha summing to 1 (those functions were not mutated), most EV arithmetic which uses `ev.ts` closed forms directly. Isolation is working: a wrong `potOdds` does not make `evOfBet` lie, and the one test whose job is the seam failed.

### TEST-027

Three independent production breaks, three corresponding suites failed. Requirement met.

**A mutation that would *not* have been caught by a named test, stated precisely:**

If `cardsHiddenFrom` were changed to always return `[]` **and** a reviewer looked only at `assertNoHiddenCards` (which uses that function as the oracle for “hidden”), the JSON scan would become vacuous. The first hidden-information test **also** asserts `other.holeCards === null` directly, so a leak would still fail that test. A future test that only called `assertNoHiddenCards` would not.

If `exactEquity` were replaced with `return 0.82` for every preflop two-hand spec, `calc.test.ts`’s `0.80 < heroEquity < 0.84` **would pass**. `coach.test.ts`’s `7/44` turn spot would fail. The published 81.946% figure is not itself a literal in the math package.

---

## Inventory of skipped / weak / mock / timing

### Skips (runtime, not disabled tests)

All go through `databaseSkip` / `DB_SKIP_REASON` / a `skipReason` seeded from it, plus `w3-fixture-teardown-privileges.test.ts` `t.skip(reason)` when the least-privilege role cannot be opened.

Files that skip SQL when `DATABASE_URL` is unset (non-exhaustive): `hands.test.ts`, `hand-sort.test.ts`, `hidden-information-api.test.ts` (HTTP describe only), `repositories.test.ts`, `content-routes.test.ts`, `coverage-*.test.ts`, `y2-quiz-attempt-recording.test.ts`, `x1-unpayable-sizing.test.ts`, `shutdown.test.ts` (one WS-upgrade case), `coverage-session-conformance.test.ts` (SQL half only; Map half still runs).

**CI cannot use this skip:** `database-availability.test.ts` `refuses to let CI waive the database suites`.

No permanent `skip: true` / `skip: 'temporarily'`.

### Weak or narrow assertions (not vacuous enough for P0)

| Site | Why it cannot fail some production lies |
| --- | --- |
| `apps/api/test/calc.test.ts` AA vs KK | `0.80 < equity < 0.84` and `trials === 1_712_304`. A constant `0.82` passes the band. |
| `scripts/smoke-test.mjs` AA vs KK | 75–88% “plausible”. |
| `packages/poker-math/test/equity.test.ts` | Four tests; hostile Monte Carlo input only. No `exactEquity` call. |
| `assert.doesNotThrow` sites | Supplementary (min samples, format infinity, empty range parse). Always paired with stronger tests in the same file, except as extra belts. |
| Most `apps/web/test/*.test.ts` | Source text, not behaviour. A refactor that keeps the string and breaks the runtime would pass. |
| `packages/ui/test/layout-guarantees.test.ts` | CSS text, not a hit-test. Honest about that. |
| Reachability / availability floor counts | `manifests.length >= 8`, `files.length > 8` — anti-empty, not a substitute for the empty-array equality that follows. |

### Mock / fake seams in the “integration” package

Honest headers, not hidden:

- `auth.test.ts` — Map store; OIDC round-trip uses the real relying party.
- `rooms.test.ts` — Map store + manual clock.
- `ws-router.test.ts` — recorder sink; real Ajv.
- `ws-socket.test.ts` — **real socket + real hub + real LiveTable**; room/session rows faked.
- Hand HTTP harness — stub `request.session`; real cookie signing, helmet, Ajv; SQL is real when DB is up.

Postgres conformance exists for sessions and rooms. This is not “integration = mocks only”.

### Timing

- Good: manual clocks (`y3-turn-clock`, rooms, ws-router).
- Residual: `shutdown.test.ts` 150–200 ms sleeps to hold a half-written HTTP body; `ws-socket` 15 s frame timeout (fail-closed).
- Fixed class: `z1-settled-hand-invariants.test.ts` documents why “some stack changed” was a flake on chops.

### Hard-coded probabilities

Justified:

- Quiz calculation **inputs** (`packages/content/data/quizzes.json` `equity: 0.4` etc.).
- Published 5-card / 7-card category tables.
- Coach literals derived in comments (`7/44`, `0.36`, EV longhand).
- Web fixtures: generator output, **recomputed** by `web-fixture-figures.test.ts`.

Not independently derived at published precision: AA vs KK 81.946% (band only).

---

## Findings

### P0 — critical correctness test that would pass if production returned 0

**None found.**

Candidates checked and rejected:

- Hidden-information JSON scan — fails on leaked cards (M1).
- Evaluator frequencies — fail on misclassification (M2).
- Pot-odds `1/3` — fails if the function returns `0` or `0.25` (M3).
- Coach `7/44` and raise EV longhand — would fail on `0`.
- Database availability — fails closed, does not `return` success on a missing DB unless waived.

### P1 — major suites missing from the release gate; skipped required behaviour; mock-only integration

**None that meet the stated P1 bar.**

- Exhaustive, simulation, a11y, `security:audit`, `db:verify` are in `verify` and in CI.
- Database skips are refused when `CI` is set.
- Integration-named files that use Maps are accompanied by SQL conformance / real-socket tests.

### P2

1. **`exactEquity` is untested as a function; the famous AA-vs-KK figure is a 4-point band at the HTTP layer.** `packages/poker-math/test/equity.test.ts` never calls it. A preflop-only constant `0.82` would satisfy `calc.test.ts` and the smoke harness. The Coach `7/44` spot is a different street and would still catch a global `return 0`.
2. **`apps/web` component behaviour is mostly ungripped at runtime.** 16 files, majority `readFileSync` + regex. ADR 0008 is the reason (no DOM). `test:a11y` covers delivered HTML, not error-only branches (those are the source greps). A broken client reducer that did not change source strings could slip the web suite; `table-socket.test.ts` and `quiz-attempts.test.ts` are the exceptions.
3. **Default `pnpm test` is not the evidence set the README’s correctness section describes.** Exhaustive 133M and the 8 000-hand profile simulation are opt-in / `verify` / CI jobs. Documented, but a green `pnpm test` does not include them. (Not a release-gate hole.)
4. **`shutdown.test.ts` still contains sleep-to-arm delays** (120–200 ms) around SIGTERM. Fail-closed timeouts exist; the sleeps are a flake surface on a slow or overloaded runner.
5. **`scripts/a11y-audit.mjs` and `scripts/check-contrast.mjs` have no unit tests of their own logic.** They are executed as gates. A silent no-op auditor would only be caught if a known-bad page were in the crawl set.
6. **Several hidden-information tests do not inspect `PlayerView`** (they inspect commitment reveals). Correct for their names; a reader treating the file as 11 leak tests overstates the view-scan count (7 of 11 failed M1).

### P3

1. Satellite `assert.doesNotThrow` (cannot fail a wrong numeric result).
2. `as unknown as` fixture casts in tests.
3. `.catch(() => undefined)` on pool/client teardown.
4. Crude CSS parsers in `layout-guarantees.test.ts` / `motion.test.ts`.
5. `databaseSkip` keys only on `DATABASE_URL` presence; unreachable schema is a hard fail only because `probeSchema` in the availability file runs. Deleting that one file would re-open skip-on-DSN-set-but-dead (other files do their own probe; not all).
6. Nested `node --test` without unsetting `NODE_TEST_CONTEXT` reports `tests 0` and exits 0. The reachability suite documents and clears it; other spawn sites must copy that.

---

## Counts

| Item | Count |
| --- | ---: |
| `*.test.ts` / `*.test.mjs` files | 121 |
| `test(` / `it(` declarations | 1669 |
| `it.skip` / `describe.skip` / `test.skip` / `xtest` / `.only` | 0 |
| Literal `{ skip: '…' }` / `{ skip: true }` in executable tests | 0 (fixtures in reachability guard only) |
| Conditional DB skips (identifier) | ~15 files |
| `TODO`/`FIXME`/`HACK` skipping tests | 0 |
| `@ts-ignore` / `as any` in tests | 0 |
| `assert.ok(true)` | 0 |
| Empty `catch {}` in tests | 0 |
| Mutations attempted | 3 |
| Mutations caught by the matching suite | 3 |
| P0 | 0 |
| P1 | 0 |
| P2 | 6 |
| P3 | 6 |
| Full `pnpm run test` this audit | not run |
| `test:scripts` this audit | 102 pass / 0 skip / 0 fail |

---

## Bottom line

The test system is built to refuse the failure mode this review is for: empty success. Reachability, database-availability, schema-verify-can-fail, and supply-chain `--offline` exits non-zero are real guards, not comments. Engine, odds/EV, Coach legality, hidden-information, and session conformance are written so that independent numbers and hostile inputs can fail them — and three `/tmp` mutations did fail them.

What this audit did **not** prove: that `pnpm run test` is green on this machine today, that the 133 784 560-hand run still matches, or that the web UI does what its source strings say. The two material quality gaps are (1) exact preflop equity pinned only by a wide HTTP band, and (2) the Next.js client tested largely as text.

No P0 vacuous critical test. No P1 missing-from-release-gate / skipped-required / mock-only-integration finding.
