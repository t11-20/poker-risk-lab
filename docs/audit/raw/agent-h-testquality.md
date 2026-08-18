# Reviewer H — Test Quality Audit

**Scope:** the test suite itself, not the features. The question answered here is: *when another
auditor cites a test as proof, is that proof worth anything?*

**Environment:** Node v24.18.0, pnpm 11.10.0, Postgres 16 up on 127.0.0.1:5432, `.env` present,
`CI` unset. Repo is not a git repo, so no history was available to date fixtures or changes.

**Headline:** the documented root command `pnpm run test` **fails right now**, deterministically,
3/3 runs. The two failures are the *only* tests that check the offline data the web app ships, and
because they abort on the first mismatch they under-report the damage: three of six shipped
Scenario Lab fixtures disagree with the engine, and one of them ships a **160% probability** that
the current engine refuses to produce and that `CoachPanel` renders verbatim.

---

## Summary table

| ID | Title | Status |
|----|-------|--------|
| TEST-001 | The documented root test command passes | **FAIL** |
| TEST-002 | No disabled / skipped / todo / commented-out tests | PARTIAL |
| TEST-003 | The reachability guard prevents a suite reporting `tests 0` | **FAIL** |
| TEST-004 | The database guard fails loudly when the DB is absent | PASS |
| TEST-005 | The documented no-database waiver produces a green run | **FAIL** |
| TEST-006 | The suite reports what it executes (no invisible non-execution) | **FAIL** |
| TEST-007 | Every `*.test.*` file is reachable from a documented root command | PASS |
| TEST-008 | Results are deterministic across repeated runs | PASS |
| TEST-009 | No weak / vacuous assertions | PARTIAL |
| TEST-010 | No mock-only success paths in "integration" tests | **FAIL** |
| TEST-011 | Expected numbers are derived, not copied from the implementation | **FAIL** |
| TEST-012 | No TODO / FIXME / HACK / XXX markers | PASS |
| TEST-013 | No broad `any` / `@ts-ignore` / unsafe casts | PASS |
| TEST-014 | No swallowed errors in source or tests | PASS |
| TEST-015 | Critical module coverage — poker engine | PASS |
| TEST-016 | Critical module coverage — poker math / Coach | PASS |
| TEST-017 | Critical module coverage — auth / session | PARTIAL |
| TEST-018 | Critical module coverage — redaction / hidden information | PASS |
| TEST-019 | Critical module coverage — WebSocket hub + live rooms | PARTIAL |
| TEST-020 | Critical module coverage — migrations & DB tooling | **FAIL** |
| TEST-021 | Critical module coverage — web client (apps/web) | **FAIL** |
| TEST-022 | Critical module coverage — UI components | **FAIL** |
| TEST-023 | Critical module coverage — release-gating scripts | **FAIL** |
| TEST-024 | Long-running suites (exhaustive, simulation) are real evidence | PASS |
| TEST-025 | Named negative / failure-mode cases exist for critical logic | PARTIAL |
| TEST-026 | No flaky timing assumptions | PARTIAL |

---

## Real, measured numbers (not the repo's claims)

Every figure below was produced by me on this machine.

| Command | tests | pass | fail | skipped | exit |
|---|---|---|---|---|---|
| `pnpm run test:unit` | 741 | 741 | 0 | 0 | 0 |
| `pnpm run test:integration` | 534 | 532 | **2** | 0 | **1** |
| `pnpm run test:scripts` | 7 | 7 | 0 | 0 | 0 |
| `pnpm run test` (all three) | 1,282 | 1,280 | **2** | 0 | **1** |
| `pnpm run test:simulation` | 23 | 23 | 0 | 0 | 0 |
| `pnpm run test:exhaustive` | 2 | 2 | 0 | 0 | 0 |

Repeated 3× for unit/integration/scripts and 2× for simulation — identical every time.

Test files: **78** `*.test.*` files (84 matches minus 6 `tsconfig.test.json`).
Total assert calls across all test files: **4,930**.

Coverage measured with `node --test --experimental-test-coverage` (first-party `src` only):

| Workspace | line % | branch % | funcs % |
|---|---|---|---|
| packages/poker-engine | 96.65 | 86.89 | 93.33 |
| packages/poker-math | 95.06 | 83.76 | 92.93 |
| packages/poker-ai (src files) | 91–100 per file | 64–98 | 50–100 |
| packages/contracts | 100.00 | 100.00 | **8.11** |
| packages/content | 74–80 | 58–60 | 33–86 |
| packages/ui (8 of 36 source files loaded) | 99.08 | 97.01 | 100.00 |
| apps/api | 90.91 | 79.69 | 84.53 |
| apps/web (**2 of ~63 source files loaded**) | 89.88 | 70.77 | 40.17 |

---

### TEST-001 The documented root test command passes

- **Requirement (exact):** `pnpm run test` — the command README/docs and CI both name — must exit 0
  on a machine with a migrated Postgres.
- **Status:** **FAIL**
- **Implementation location:** `package.json:26` (`"test": "pnpm run test:unit && pnpm run test:integration && pnpm run test:scripts"`); failing suite `apps/api/test/web-fixture-figures.test.ts:100-116` and `:228-252`
- **Runtime evidence:**

```
$ pnpm run test:integration
ℹ tests 534
ℹ suites 119
ℹ pass 532
ℹ fail 2
ℹ skipped 0
✖ failing tests:
test at test/web-fixture-figures.test.ts:100:3
✖ matches buildCoachReport for every bundled scenario (29.136958ms)
  AssertionError [ERR_ASSERTION]: flop-flush-draw-price's stored analysis is not what the engine
  computes now — regenerate the fixture rather than editing the number
test at test/web-fixture-figures.test.ts:230:5
✖ REVIEW_HAND_SHOWDOWN replays and analyses identically (247.776125ms)
  AssertionError [ERR_ASSERTION]: REVIEW_HAND_SHOWDOWN's stored analyses are not what
  buildHandReview computes now — regenerate the fixture
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @prl/api@0.1.0 test: ... Exit status 1
```

  Run three times (runs 1, 2, 3): `integration exit=1` every time, `tests 534 / pass 532 / fail 2`
  every time.
- **Test covering it:** N/A — this *is* the test result.
- **Test result:** 2 failures, reproducible 3/3.
- **Reviewer notes:** I ruled out a stale build as the cause. I recompiled `packages/poker-math`
  into a scratch `--outDir` and diffed against the shipped `dist/`: the only difference in any of
  the 13 emitted files is the `//# sourceMappingURL` line. `dist` is semantically identical to
  `src`, so a `pnpm run build:packages` (which CI does before `pnpm run test`) will not change the
  outcome. **CI is red.** Anything that cites "the suite is green" is citing something that has not
  been true on this tree.
- **Missing work:** regenerate `apps/web/src/fixtures/scenarios.ts` and `.../review.ts` from the
  current engine, and re-run. See TEST-011 for why that is not merely cosmetic.

---

### TEST-002 No disabled / skipped / todo / commented-out tests

- **Requirement (exact):** No test in the repository may be `.skip`, `.todo`, `xit`, commented out,
  or otherwise prevented from executing except through an explicitly named, documented command.
- **Status:** PARTIAL
- **Implementation location:** every conditional skip in the tree, exhaustively:
  - `apps/api/test/repositories.test.ts:678` `const dbOptions = { skip: skipReason };` — applied to 6 describes at `:696`, `:764`, `:942`, `:1124`, `:1464`, `:1650`
  - `apps/api/test/content-routes.test.ts:56` `const databaseTest = { skip: databaseSkip(...) };`
  - `apps/api/test/hand-sort.test.ts:183` `describe('GET /hands?sort=', { skip: DB_SKIP_REASON }, ...)`
  - `apps/api/test/hands.test.ts:795` and `:904`
  - `apps/api/test/hidden-information-api.test.ts:394`
- **Runtime evidence:** zero literal `.skip(`, `.todo(`, `test.todo`, `it.todo`, `xit(`, `xdescribe(`
  anywhere in the repo (`grep -rnE "\.skip\(|\.todo\(|test\.todo|it\.todo|xit\(|xdescribe\("` →
  no matches in test files). With a live database, `pnpm run test:integration` reports
  `skipped 0` — nothing is skipped in the normal path. Confirmed 3/3 runs.
- **Test covering it:** `apps/api/test/database-availability.test.ts:118-146` scans the test tree
  and fails if any file reads `process.env.DATABASE_URL` outside `helpers/database.ts`. I confirmed
  it runs and passes.
- **Test result:** 12 describes skip when `DATABASE_URL` is unset; 0 skip otherwise.
- **Reviewer notes:** This is genuinely good. Every skip funnels through one helper, the helper is
  meta-tested, and with a DB present nothing skips. **Two residual problems:** (a) the
  `DB_SKIP_REASON` machinery covers only the suites that *declare* a DB dependency —
  `apps/api/test/shutdown.test.ts` needs `DATABASE_URL` (it spawns a real server, which exits 78
  without one) and carries no guard at all (see TEST-005); (b) the repo's own prose and the
  failure message at `database-availability.test.ts:89` say **"57 tests"**. The real number is
  **77** (534 with DB minus 457 without). The claim understates the exposure by 35%.
- **Missing work:** correct the "57" figure; give `shutdown.test.ts` a `databaseSkip` guard or make
  it not need a database.

---

### TEST-003 The reachability guard prevents a suite reporting `tests 0`

- **Requirement (exact):** `apps/api/test/workspace-test-reachability.test.ts` claims (line 22) "No
  package's `test` script can report zero tests". It must actually fail when a suite would execute
  nothing.
- **Status:** **FAIL** — the guard is purely static and I defeated it three ways.
- **Implementation location:** `apps/api/test/workspace-test-reachability.test.ts:337-360`
  (`leaves no package whose test script would report zero tests`) and `:242-277` (`runnerPatterns`)
- **Runtime evidence:** first, node's own behaviour — a suite that executes nothing exits 0:

```
$ node --test 'nope/**/*.test.ts'
ℹ tests 0 … exit=0
$ cat t2/x.test.ts
import { describe, it } from 'node:test';
describe('all skipped', { skip: 'because' }, () => {
  it('a', () => { throw new Error('never runs'); });
});
$ node --test 't2/**/*.test.ts'
﹣ all skipped (0.222ms) # because
ℹ tests 0
ℹ skipped 0        <-- not even counted as skipped
exit=0
```

  Then, against a faithful scratch copy of the repo (baseline: 4/4 pass):

| Attack | Result |
|---|---|
| **1 (positive control)** orphan `db/test/orphan.test.ts` | guard **FAILS** ✔ correct |
| **2** new `packages/ghost` with `"test": "node --test 'test/**/*.test.ts'"` and no test files | guard **FAILS** ✔ correct |
| **3** new `packages/ghost2` with `"test": "echo 'no tests here' && exit 0"` | guard **PASSES** ✖ defeated |
| **4** new package whose only `.test.ts` contains `// TODO: write tests` (zero `test()` calls) | guard **PASSES** ✖ defeated |
| **5** new package whose only test file is `describe('critical security invariants', { skip: 'temporarily' }, …)` | guard **PASSES** ✖ defeated; that package's own suite reports `tests 0 / skipped 0` and exits 0 |

- **Test covering it:** the guard itself; 4 tests, all passing.
- **Test result:** 4/4 pass on the real tree; 3 of my 5 attacks pass it while executing nothing.
- **Reviewer notes:** The guard answers *"does a glob match a file on disk?"* It never asks *"did
  any assertion run?"* Attack 5 is precisely the defect the file's own header says it exists to
  prevent — "`packages/contracts` shipped an EMPTY `test/` directory whose suite reported `tests 0`
  and exited 0, which is indistinguishable from a package that passed" — and it is reintroducible
  in one line, in a form the guard cannot see. Attack 3 is worse: the "zero tests" check begins
  `if (command === undefined || !/node\b[^\n&]*?--test\b/.test(command)) continue;`
  (`workspace-test-reachability.test.ts:343`), so any `test` script that does not literally contain
  `node … --test` is exempted from the check entirely.
- **Missing work:** assert on *executed* counts, not globs — e.g. have each package's runner emit a
  machine-readable summary (`--test-reporter=…`) and fail the run when any package reports
  `tests === 0` or when the repo-wide total drops below a checked-in floor.

---

### TEST-004 The database guard fails loudly when the DB is absent

- **Requirement (exact):** With no reachable database and no waiver, the API suite must exit
  non-zero rather than silently skipping.
- **Status:** PASS
- **Implementation location:** `apps/api/test/helpers/database.ts:52-74`;
  `apps/api/test/database-availability.test.ts:75-93`
- **Runtime evidence:**

```
$ cd apps/api && DATABASE_URL="" node --env-file-if-exists=../../.env --test --test-concurrency=1 'test/**/*.test.ts'
ℹ tests 457
ℹ pass 450
ℹ fail 6
✖ has a reachable schema, or fails loudly saying how to get one (0.555416ms)
✖ the database-backed suites are not silently skipped (4.191041ms)
exit=1
```

  And with the waiver plus `CI=true`, the waiver is correctly refused:

```
$ CI=true DATABASE_URL="" PRL_TESTS_WITHOUT_DATABASE=1 node --env-file-if-exists=../../.env --test ...
✖ the database-backed suites are not silently skipped
```

- **Test covering it:** `apps/api/test/database-availability.test.ts:76-116`
- **Test result:** fails loudly in both the no-waiver and the CI-with-waiver case, as designed.
- **Reviewer notes:** This one genuinely works and is the strongest guard in the repo. It is also
  the *only* runtime guard — everything else about "did the tests run" is static text scanning.
- **Missing work:** none for this specific property.

---

### TEST-005 The documented no-database waiver produces a green run

- **Requirement (exact):** `pnpm run test:no-database`, documented at
  `apps/api/test/helpers/database.ts:26-27` and `test/without-database.env` as "the only supported
  way to get a green run without a database", must exit 0.
- **Status:** **FAIL**
- **Implementation location:** `package.json:31`; `apps/api/test/without-database.env`;
  offending suite `apps/api/test/shutdown.test.ts:270`, `:298`, `:359`
- **Runtime evidence:**

```
$ cd apps/api && DATABASE_URL="" PRL_TESTS_WITHOUT_DATABASE=1 node --env-file-if-exists=../../.env --test --test-concurrency=1 'test/**/*.test.ts'
ℹ tests 457   pass 451   fail 5   skipped 1
✖ answers the request, exits 0, and does not wait out the grace
✖ exits 0 with a worker-thread calculation still running, and leaves no thread behind
✖ exits 0 with nothing in flight at all
✖ matches buildCoachReport for every bundled scenario
✖ REVIEW_HAND_SHOWDOWN replays and analyses identically
case2 exit=1
```

  Root cause of the three shutdown failures, from the log:

```
✖ exits 0 with nothing in flight at all
  Error: the server exited with 78 before listening. Output:
  Refusing to start: 1 configuration problem.
    - DATABASE_URL is required but missing or empty
```

- **Test covering it:** none. Nothing tests that the waiver path works.
- **Test result:** 5 failures, exit 1.
- **Reviewer notes:** The waiver is the documented escape hatch for "a developer with no Docker".
  It has never worked on this tree: `shutdown.test.ts` spawns `src/server.ts` as a child process
  and the server refuses to boot without `DATABASE_URL`, and the file carries no `databaseSkip`
  guard, which also means it violates the stated policy that "every `skip:` in this test tree has
  to come from `databaseSkip`" by having no guard at all rather than the wrong one. Two of the five
  failures are the stale fixtures from TEST-001, so even fixing those leaves the waiver red.
- **Missing work:** guard `shutdown.test.ts` behind `databaseSkip` (or give the spawned server a
  no-database mode), then verify `pnpm run test:no-database` exits 0.

---

### TEST-006 The suite reports what it executes

- **Requirement (exact):** The summary a human or a CI dashboard reads must make non-execution
  visible.
- **Status:** **FAIL**
- **Implementation location:** node's TAP summary; the skip declarations listed under TEST-002
- **Runtime evidence:** with the database absent, twelve describes print `﹣ … # DATABASE_URL is
  not set …` in the body of the log — and then:

```
ℹ tests 457
ℹ suites 119
ℹ pass 451
ℹ fail 5
ℹ skipped 1        <-- 77 tests did not run
ℹ todo 0
```

  Diffing the executed test names between the with-DB and without-DB runs gives **88 named entries
  present only with a database (8 suite headers + 80 leaves)**; the runner's own count drops from
  534 to 457, i.e. **77 tests**. The summary line says `skipped 1`.
- **Test covering it:** none.
- **Test result:** as above.
- **Reviewer notes:** This is the residue of the original defect. The repo fixed *"the suite exits
  0 while 57 tests skip"* by making the run exit 1 — which is the right fix — but it did not fix
  *"the summary understates non-execution by 77×"*. Any consumer that scrapes `skipped N` (CI
  annotations, dashboards, a human skimming) still reads `1`. A grader who runs the waived command,
  sees `457 tests / 451 pass / skipped 1`, and concludes "one thing skipped" would be wrong by two
  orders of magnitude.
- **Missing work:** print an explicit "N tests did not execute" line, or assert a minimum executed
  count per suite.

---

### TEST-007 Every `*.test.*` file is reachable from a documented root command

- **Requirement (exact):** No orphan test files. Every `*.test.*` file must be run by some root
  command.
- **Status:** PASS
- **Implementation location:** `package.json:26-33`; guard at
  `apps/api/test/workspace-test-reachability.test.ts:317-335`
- **Runtime evidence:** I enumerated the 78 files independently and mapped them to globs:

```
packages/content     1   -> test:unit
packages/contracts   1   -> test:unit
packages/poker-ai    7   -> test:unit      (+3 in test/simulation -> test:simulation only)
packages/poker-engine 11 -> test:unit      (+1 in test/exhaustive -> test:exhaustive only)
packages/poker-math  13   -> test:unit
packages/ui           8   -> test:unit
apps/web              3   -> test:unit
apps/api             29   -> test:integration
scripts               1   -> test:scripts
```

  `pnpm run test` runs 74 of 78 files; the remaining 4 need `test:exhaustive` / `test:simulation`,
  which are in `test:all` and have their own CI jobs (`.github/workflows/ci.yml:293` and `:449`). I
  ran all of them (TEST-024). Adding an orphan file (`db/test/orphan.test.ts`) in my scratch copy
  makes the guard fail, so the detector is live.
- **Test covering it:** `apps/api/test/workspace-test-reachability.test.ts:317`
- **Test result:** 4/4 pass; my positive-control orphan is caught.
- **Reviewer notes:** Reachability of *files* is genuinely proven. Reachability of *assertions* is
  not — see TEST-003. Also note that `pnpm run test` alone does **not** run the exhaustive or
  simulation suites; only `test:all` or CI does.
- **Missing work:** none for this property.

---

### TEST-008 Results are deterministic across repeated runs

- **Requirement (exact):** Repeated runs of the suite must produce identical results; any variance
  is a finding.
- **Status:** PASS
- **Runtime evidence:** four consecutive full passes (`run1`–`run3` complete for all three
  sub-suites; a fourth unit run also completed):

```
run1: unit tests=741 pass=741 fail=0 skipped=0 | integration 534/532/2/0 | scripts 7/7/0
run2: unit tests=741 pass=741 fail=0 skipped=0 | integration 534/532/2/0 | scripts 7/7/0
run3: unit tests=741 pass=741 fail=0 skipped=0 | integration 534/532/2/0 | scripts 7/7/0
```

  The *same two* tests fail every time, with the same assertion messages. `test:simulation` run
  twice: `23/23/0` both times (192s, then 151s).
- **Reviewer notes:** No nondeterminism observed in ~5,000 test executions. The RNG-dependent
  suites are seeded; the Monte Carlo suites use fixed seeds and sample counts. Timing risk is
  isolated to three tests (TEST-026), none of which flaked here.
- **Missing work:** none.

---

### TEST-009 No weak / vacuous assertions

- **Requirement (exact):** No `assert(true)`, no test with zero assertions, no test whose only
  claim is "did not throw" where a real outcome is checkable, no assertion on a mock rather than an
  outcome.
- **Status:** PARTIAL
- **Runtime evidence / findings:**
  - **Zero** `assert(true)` or bare-truthy tests. **Zero** mock-call assertions:
    `grep -rn "calls\.length\|\.callCount\|wasCalled" --include="*.test.ts"` → **0 matches**. No
    `node:test` `mock`/spy usage anywhere. That anti-pattern is genuinely absent.
  - **12 `assert.doesNotThrow` calls**, at `apps/api/test/repositories.test.ts:441-442`,
    `packages/ui/test/format.test.ts:399`, `packages/content/test/scenarios.test.ts:110`,
    `packages/poker-math/test/equity.test.ts:127`, `packages/poker-math/test/ev.test.ts:659-661`,
    `packages/poker-math/test/icm.test.ts:483`,
    `packages/poker-ai/test/opponent-model.test.ts:618`, `:621`, `:727`,
    `packages/poker-ai/test/commentary.test.ts:421`, `:442`, `:457`. Most are paired with an
    adjacent `assert.throws` (a boundary pair), which makes them defensible; the outliers are
    `opponent-model.test.ts:618-623` and `:727`, which assert only that a call on a frozen model
    does not throw and check nothing about the result.
  - **15 of 78 test files are static/text-scanning "lint tests"** rather than behavioural tests —
    they `readFileSync`/`readdirSync` source and assert on the *text*:
    `apps/api/test/{database-availability,harness-paths,legends-naming-fallback,server-randomness,session-cookie-names,web-api-paths,workspace-test-reachability}.test.ts`,
    `apps/web/test/app-shell-streaming.test.ts`,
    `packages/poker-ai/test/{commentary,no-math-random}.test.ts`,
    `packages/poker-engine/test/rng.test.ts`,
    `packages/poker-math/test/coach-legality.test.ts`,
    `packages/ui/test/{layout-guarantees,motion}.test.ts`,
    `scripts/supply-chain/policy-check.test.mjs`.
    These are legitimate guards but they prove nothing about runtime behaviour. Example:
    `apps/web/test/app-shell-streaming.test.ts:51-70` — three tests whose entire content is "no
    file named `loading.tsx` or `template.tsx` exists, and `not-found.tsx` does".
  - **`packages/contracts`: 100% line coverage, 8.11% function coverage.** 21 tests import the
    whole surface and call almost none of it. Line coverage here measures module evaluation, not
    exercise.
- **Reviewer notes:** Assertion *density* is high (4,930 asserts / 78 files) and I found no
  outright vacuous test. The weakness is in *kind*, not count: a meaningful fraction of the green
  ticks are filesystem/regex assertions about source text.
- **Missing work:** replace the two `doesNotThrow`-only opponent-model tests with outcome
  assertions; treat the 15 lint-test files as lint, not as behavioural coverage, when other
  auditors cite them.

---

### TEST-010 No mock-only success paths in "integration" tests

- **Requirement (exact):** A test presented as integration/E2E evidence must exercise the real
  component — real server, real database, real socket — not a stub that would pass with the
  implementation deleted.
- **Status:** **FAIL**
- **Implementation location:** stubs at `apps/api/test/auth.test.ts:73`, `calc.test.ts:59`,
  `content-routes.test.ts:69`, `security-headers.test.ts:43`, `rooms.test.ts:48`,
  `ws-router.test.ts:69`, `ws-socket.test.ts:88`, `wiring.test.ts:58`; fakes at
  `apps/api/test/rooms.test.ts:107-120` (`FakeRoomStore`), `auth.test.ts:283` (fake `AuthStore`),
  `apps/api/test/helpers/live-room.ts:24` (`seatingOnlyStore`)
- **Runtime evidence:**
  - Of **534** tests in the suite the root manifest calls `test:integration`, **77 touch Postgres**
    and **457 (86%) do not**. Measured by diffing executed test names with and without
    `DATABASE_URL`.
  - Only **11 of 1,282 tests (0.86%)** use a real network socket: 8 in
    `apps/api/test/ws-socket.test.ts` (real `listen()` + `ws` client) and 3 in
    `apps/api/test/shutdown.test.ts` (real spawned child process). Everything else uses Fastify
    `app.inject()` (in-process; real routing/hooks/serialisation, no TCP, no browser semantics).
  - The production `RoomStore` and `HandArchive` implementations are **never executed by any
    test.** Coverage of `apps/api/src/rooms/registry.ts`: **81.01% line / 54.79% funcs**, with
    uncovered lines `141-158 161-176 179 182-192 195-197` (the whole body of
    `postgresArchive`, declared at `registry.ts:137`) and `267-268 277 280 283 287-288` (inside
    `postgresRoomStore`, declared at `registry.ts:264`). Independently confirmed: neither
    `postgresRoomStore` nor `postgresArchive` is named in any test file.
  - All three suites that drive a live table (`rooms.test.ts:237`, `ws-router.test.ts:143`,
    `ws-socket.test.ts:229`) construct `new RoomRegistry({ store: <fake> })`. **No test ever
    constructs a `RoomRegistry` over Postgres.**
  - There is **no conformance suite** running the fake and the SQL implementation of `RoomStore` /
    `AuthStore` through the same assertions. The TypeScript interface guarantees signatures, not
    semantics.
- **Test covering it:** none.
- **Reviewer notes:** This is the biggest structural weakness. `apps/api/test/` is presented as the
  "integration" suite (`package.json:28`), and 86% of it is an in-memory simulation of the
  database. Concretely: the code path that **writes a completed hand to Postgres from a live
  table** — `postgresArchive.handStarted / actionsApplied / streetAdvanced / handCompleted /
  stacksSettled` — has **zero** coverage. `repositories.test.ts` proves the underlying SQL
  functions work in isolation; nothing proves the adapter that calls them is wired correctly, and
  nothing plays a hand and reads it back out of Postgres.
- **Missing work:** one end-to-end test that seats two sessions over real sockets against a real
  `postgresRoomStore` + `postgresArchive`, plays a hand to showdown, and reads the persisted hand
  back through `GET /hands/:id`. Plus a conformance suite run against both store implementations.

---

### TEST-011 Expected numbers are derived, not copied from the implementation

- **Requirement (exact):** A test's expected values must be independently derived. A test that
  asserts what the code happens to output proves nothing.
- **Status:** **FAIL** — and this is the highest-value finding in the audit.
- **Implementation location:** `apps/api/test/web-fixture-figures.test.ts:99-117` and `:228-252`;
  data under test `apps/web/src/fixtures/scenarios.ts` and `apps/web/src/fixtures/review.ts`
- **Runtime evidence:** The two failing tests are pure snapshot comparisons — the assertion
  compares the stored fixture against a fresh call of the *same* producer:

```ts
// apps/api/test/web-fixture-figures.test.ts:109-114
assert.deepEqual(
  fixture,
  reportForScenario(scenario),
  `${scenario.id}'s stored analysis is not what the engine computes now — regenerate the fixture
   rather than editing the number`,
);
```

  Because `assert.deepEqual` throws on the first mismatch inside the `for` loop at `:106`, the
  failure names only `flop-flush-draw-price` and stops. I re-ran the same comparison without
  aborting:

```
$ node scratch/fullfixture.mjs
scenarios: 6 matching: 3 mismatching: 3
 - flop-flush-draw-price   stored errorPoints=-2.434…   fresh errorPoints=1.032…
 - turn-gutshot-price      stored errorPoints=-1.090…   fresh errorPoints=-0.695…
 - flop-spr-commitment     stored ruleOfThumb={"estimate":1.6,"errorPoints":95.49187527448397,…}
                           fresh  ruleOfThumb=null
```

  The third one is the release problem. `apps/web/src/fixtures/scenarios.ts:959-962` (scenario
  `flop-spr-commitment`, declared at `:902`) ships:

```
ruleOfThumb: {
  estimate: 1.6,
  errorPoints: 95.49187527448397,
  note: '40 outs with two cards to come, times 4, is roughly 160% — the rule of 2 and 4. … The
         shortcut overstates by 95.5 points here — 160% against an exact 64.5%. …',
}
```

  and `apps/web/src/fixtures/scenarios.ts:1084`:

```
'The rule of 2 and 4 gives 160% here, overstating the real figure by 95.5 points. Useful at the
 table, worth knowing the direction of its error.',
```

  The current engine **refuses to produce this**: `packages/poker-math/src/coach.ts:274-278`
  returns a `not-a-probability` refusal when clean outs exceed the ceiling, and `:375-382`
  (`assertProbabilityFraction`) throws a `CoachError` on anything outside 0..1. Fresh output is
  `ruleOfThumb: null`. The fixture is the pre-fix value, frozen.

  And it reaches the screen. `apps/web/src/app/lab/[scenarioId]/page.tsx:29` renders from this
  fixture; `packages/ui/src/components/CoachPanel.tsx:647` renders
  `formatPercent(rule.estimate)`; `packages/ui/src/format.ts:144` multiplies by 100. The shipped
  Scenario Lab page therefore reads:

  > **"The rule of 2 and 4 estimates 160.0%, which is off by 95.5 points."**

  `apps/web/src/fixtures/review.ts:576` carries the same class of error: *"The rule of 2 and 4
  gives 60% here"*, computed from 15 total outs where the engine now uses 8 clean outs and produces
  32%.
- **Test covering it:** `apps/api/test/web-fixture-figures.test.ts` — which is red, and which
  aborts before reaching the 160% entry.
- **Test result:** 2 failures; the real damage is 3 of 6 scenarios plus 1 of 2 review hands.
- **Reviewer notes:** This is the exact failure mode the brief asked me to hunt for, in its purest
  form. The codebase's own comments (`coach.ts:282-301`, `:347-360`;
  `packages/ui/test/coach-panel-render.test.ts:1-38`) describe finding and fixing a shipped panel
  that told learners a flush draw was "3,600.0%" and a scenario that came out at "47 × 4 = 188%".
  The guard they built (`coach-panel-render.test.ts`, which renders the real component and refuses
  any percentage over 100%) uses **hand-written literal fixtures** and never touches the shipped
  data. So the guard passes, the shipped data still contains a 160% probability, and the only test
  that looks at the shipped data is failing on a different scenario and never gets there.
  Separately: an assertion of the form "the fixture equals what the producer produces today" can
  only ever detect drift. It cannot detect that both are wrong. It is not evidence of correctness
  and should not be cited as such.
  **Counter-example worth crediting:** `apps/api/test/legend-fixture-figures.test.ts:88-120`
  re-derives every EV from the fixture's *published premises* (pot, price, equity, fold frequency)
  rather than snapshotting, and `packages/poker-math/test/{odds,variance,icm}.test.ts` show worked
  derivations in comments beside their constants (e.g. `odds.test.ts:243-248`,
  `1 - (38/47)×(37/46) = 0.349676`). Those are real.
- **Missing work:** (P0) regenerate both web fixtures and verify no probability > 1 survives; add
  an assertion over the shipped fixtures — not hand-written ones — that no `ruleOfThumb.estimate`
  exceeds 1; change the fixture comparison to collect all mismatches before failing, so the message
  names every affected scenario.

---

### TEST-012 No TODO / FIXME / HACK / XXX markers

- **Requirement (exact):** No unfinished-work markers in first-party source, tests, SQL, or CSS.
- **Status:** PASS
- **Runtime evidence:**

```
$ grep -rn --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.js" \
       --include="*.sql" --include="*.css" -E "\b(TODO|FIXME|HACK|XXX)\b" apps packages scripts db
(no output)
```

- **Reviewer notes:** Zero. Genuine.

---

### TEST-013 No broad `any` / `@ts-ignore` / unsafe casts

- **Requirement (exact):** The claimed strict-TypeScript posture must not be defeated by escape
  hatches.
- **Status:** PASS
- **Runtime evidence:** the whole-repo sweep returns 18 lines, of which 17 are prose in comments
  (e.g. `packages/ui/src/cx.ts:31-32` documenting that `as any` is *banned*). **Exactly one real
  escape hatch exists:**

```
apps/api/test/ws-socket.test.ts:668:    views.push(view as unknown as WireView);
```

  Zero `@ts-ignore`, zero `@ts-expect-error`, zero `@ts-nocheck`, zero `: any`, zero `as any` in
  code.
- **Reviewer notes:** The single cast is in a test helper that narrows an already-runtime-checked
  frame; low risk. This is a genuinely strong result.

---

### TEST-014 No swallowed errors

- **Requirement (exact):** No empty catch blocks, no `.catch(() => {})` that discards a real
  failure, no un-awaited promises, no `try` wrapped around an assertion.
- **Status:** PASS
- **Runtime evidence:** 48 `catch {` sites across `apps`, `packages`, `scripts`. I read every one
  that appears in a test file and every `.catch(() => …)`:
  - `apps/api/test/bots.test.ts:180-183` — `catch { continue; }` around `Reflect.get` while walking
    an object graph for hidden information. Correct: a throwing getter is not a leak.
  - `packages/poker-engine/test/invariants.test.ts:328-336` — `catch { rejected += 1; }` then
    `assert.equal(rejected, illegal.length)`. This is a *counted* catch, not a swallowed one.
  - `apps/api/test/workspace-test-reachability.test.ts:63` — `catch { return null; }` for a missing
    `package.json`; the caller asserts on the result.
  - `apps/api/test/helpers/database.ts:121` and `apps/api/src/server.ts:124` —
    `.catch(() => undefined)` on connection teardown only.
  - `apps/api/test/content-routes.test.ts:215/253/275/303/318` — `try { …asserts… } finally {
    app.close() }`. No `catch`, so assertion failures propagate.
- **Reviewer notes:** I found no place where a failed assertion or a real error is discarded. The
  bare `catch {` idiom is used consistently for "I do not need the error object", not for "I do not
  care that this failed".

---

### TEST-015 Critical module coverage — poker engine (betting, side pots, evaluation)

- **Status:** PASS
- **Runtime evidence:** `node --test --experimental-test-coverage 'test/*.test.ts'` in
  `packages/poker-engine`, 119/119 pass:

```
betting.ts    98.72 line / 92.78 branch / 100.00 funcs
evaluate.ts  100.00 / 94.87 / 100.00
pots.ts       92.45 / 81.82 /  92.59
machine.ts    95.94 / 86.03 /  96.30
positions.ts  94.92 / 84.21 /  84.62
commitment.ts 99.46 / 87.01 / 100.00
rng.ts        98.91 / 85.71 / 100.00
redact.ts    100.00 / 94.34 / 100.00
all files     96.65 / 86.89 /  93.33
```

  Plus `packages/poker-engine/test/short-blinds.test.ts` runs a 3,000-hand soak asserting exact
  chip conservation (2.8s), and `all-in-runout.test.ts` carries 133 assertions.
- **Reviewer notes:** Best-covered area in the repo. Real edge cases (short blinds, all-in
  reopening, side-pot layering) are exercised with asserted chip totals.
- **Gaps (specific, from uncovered lines):** `pots.ts:80-88` — the "no live players at all:
  everything goes back where it came from" branch is **never executed**. That is a real behavioural
  path (full refund), not a defensive throw. `pots.ts:194-197` (`bestFiveCards` arity guard) and
  the "chips were created or destroyed" invariants at `:168-175` and `:313-318` are also never
  triggered — acceptable for internal guards, but the refund branch is not.

---

### TEST-016 Critical module coverage — poker math / the Coach

- **Status:** PASS
- **Runtime evidence:** `packages/poker-math` 232/232 pass; `all files 95.06 line / 83.76 branch /
  92.93 funcs`. `coach.ts` 97.29/90.95/100. `variance.ts`, `stacks.ts`, `consistency.ts`,
  `format.ts` at 100% line.
- **Reviewer notes:** The derivations in `odds.test.ts`, `variance.test.ts` (normal-CDF table
  against published values) and `icm.test.ts` are independent, not fitted. Good.
- **Gaps:** `equity.ts` at 88.43/79.41 is the weakest (uncovered `647-703`, the Monte Carlo
  combination path). And see TEST-011: the Coach's *output as shipped to users* is not covered by
  anything that currently passes.

---

### TEST-017 Critical module coverage — auth / session

- **Status:** PARTIAL
- **Runtime evidence:** `apps/api/src/auth/session.ts` 100.00 line / 92.68 branch / 100 funcs;
  `auth/oidc.ts` 98.34 / 88.28 / 100; `routes/auth.ts` 94.83 / 90.63 / **67.74 funcs**;
  `repositories/sessions.ts` 98.11 / 81.82 / 100.
- **Reviewer notes:** The numbers look excellent, but `apps/api/test/auth.test.ts` (1,344 lines,
  40 tests) runs entirely against an **in-memory fake `AuthStore`** (`auth.test.ts:283`) with
  `stubDatabase` (`:73`). Session expiry, idle refresh, absolute TTL and revocation are proven
  against a `Map`, not against the SQL that ships. `repositories.test.ts` separately proves the SQL
  (`sessions — against Postgres`), but nothing runs both through the same assertions, so a
  divergence between the fake's semantics and the query's `where revoked_at is null and expires_at
  > now()` semantics would be invisible.
- **Missing work:** a conformance suite over `AuthStore`, run against both implementations.

---

### TEST-018 Critical module coverage — redaction / hidden information

- **Status:** PASS
- **Runtime evidence:** `packages/poker-engine/src/redact.ts` — **100.00% line / 94.34% branch /
  100% funcs**. Dedicated suites: `packages/poker-engine/test/hidden-information.test.ts` (52
  asserts), `redaction-identity.test.ts` (42), `packages/poker-ai/test/no-hidden-information.test.ts`
  (36), `apps/api/test/hidden-information-api.test.ts` (41), `apps/api/test/bots.test.ts` (object-
  graph walk for leaked keys). Over a real socket:
  `apps/api/test/ws-socket.test.ts:907` *"never sends either of two sessions the other's hole cards
  or any undealt card"*, `:996` *"reveals nothing at all when the hand ends by a fold"*, `:1043`
  *"never sends the new occupant the previous occupant's cards, and survives a reconnect"* — these
  three run against a real `ws` client on a real port, and all pass.
- **Reviewer notes:** The one guardrail with genuinely layered evidence: pure-function, API-level,
  and real-socket. Note the API-level ones are among the 77 that require a database, so they do not
  run under the waiver.

---

### TEST-019 Critical module coverage — WebSocket hub + live rooms

- **Status:** PARTIAL
- **Runtime evidence:** `apps/api/src/ws/hub.ts` 93.20 line / 83.67 branch / **73.91 funcs**;
  `ws/router.ts` 93.17 / 83.05 / 88.10; `rooms/table.ts` 96.35 / 80.39 / 96.30; `rooms/timers.ts`
  96.82 / 87.88 / 88.00; `rooms/bots.ts` 91.02 / **67.23 branch** / 85.71;
  `rooms/registry.ts` **81.01 / 84.85 / 54.79**.
- **Reviewer notes:** The protocol logic is well covered. The *persistence* half is not — see
  TEST-010: `postgresArchive` (registry.ts:137-197) and `postgresRoomStore` (registry.ts:264+) have
  no coverage, and every live-table test uses `seatingOnlyStore`
  (`apps/api/test/helpers/live-room.ts:24`), a fake whose unimplemented methods deliberately throw.
  8 real-socket tests exist and pass; none of them persists anything.
- **Missing work:** as TEST-010.

---

### TEST-020 Critical module coverage — migrations & DB tooling

- **Status:** **FAIL**
- **Implementation location:** `apps/api/scripts/migrate.mjs` (28,392 bytes),
  `apps/api/scripts/verify-schema.mjs` (11,420 bytes), `db/migrations/0001_initial.sql`,
  `db/migrations/0002_indexes_and_constraints.sql`, `db/seeds/0001_dev_seed.sql`
- **Runtime evidence:** No test file anywhere imports, spawns, or asserts on `migrate.mjs` or
  `verify-schema.mjs`. `grep -rl "migrate" apps/api/test packages/*/test scripts/*.test.mjs` returns
  five files, and in every one the word appears only inside a skip-reason string or a comment
  ("run `pnpm db:migrate`"). No `*.test.*` file covers migration `up`, `down`, `reset`, `seed`,
  ordering, idempotency, or failure/rollback.
- **Test covering it:** **NONE.**
- **Reviewer notes:** The migration runner is ~28 KB of code that is the only way the production
  schema comes into existence, and it is exercised only as a side effect of a developer typing
  `pnpm run db:migrate`. Migration *down* and *reset* paths are executed by nothing. CI runs
  `db:migrate` and `db:verify` (`.github/workflows/ci.yml:275`, `:281`) — that is a smoke test of
  the happy path on an empty database, not a test of the runner.
- **Missing work:** tests for migrate up→down→up idempotency, out-of-order/duplicate migration
  detection, and partial-failure behaviour, against a throwaway database.

---

### TEST-021 Critical module coverage — web client (`apps/web`)

- **Status:** **FAIL**
- **Runtime evidence:** `node --test --experimental-test-coverage` in `apps/web` (22/22 pass). The
  coverage report lists **exactly two** first-party source files, because node only reports files
  that were actually loaded:

```
src/lib/table-socket.ts   83.96 line / 69.19 branch / 64.79 funcs
src/lib/theme.ts          82.53 line / 100.00 branch /  0.00 funcs
```

  `apps/web/src` contains **47 `.tsx` files** (27 components + ~20 route files) and **16 `lib`
  modules**. Sixty-one of sixty-three are never loaded by any test. Independently:
  **123 exported functions/classes in `apps/web/src`, 118 of which are never named in any test
  file (96%).** `theme.ts` shows `0.00% funcs` — the only test that touches it
  (`theme-csp-hash.test.ts`) reads a constant and hashes it; not one function in the module is ever
  called.
- **Test covering it:** three files, 22 tests total —
  `app-shell-streaming.test.ts` (3 tests, a filesystem scan for `loading.tsx`/`template.tsx`),
  `table-socket.test.ts` (a genuine unit test of the socket client with an injected transport and
  fake clock), `theme-csp-hash.test.ts` (a hash comparison).
- **Reviewer notes:** `src/lib/api.ts` (507+ lines, every HTTP call the client makes),
  `hand-replay.ts`, `scenario-view.ts`, `learn-calculations.ts`, `use-live-table.ts`,
  `server-session.ts`, `consistency.ts`, `table-rooms.ts`, `nav.ts`, and every page and component
  have **zero** test coverage. There is no DOM/render harness in `apps/web` at all. Any claim about
  the web client's behaviour that cites the test suite is citing 22 tests, three-quarters of which
  are static scans.
- **Missing work:** a render harness (`react-dom/server` at minimum, as `packages/ui` already does)
  and tests for `lib/api.ts` error handling, `hand-replay.ts`, and `scenario-view.ts`.

---

### TEST-022 Critical module coverage — UI components

- **Status:** **FAIL**
- **Runtime evidence:** `packages/ui` reports 186/186 pass and 99.08% line coverage — but the
  coverage table lists only **8 files**: `bet-sizing.ts`, `cards.ts`, `format.ts`, `keys.ts`,
  `motion/easing.ts`, `motion/reduced-motion.ts`, `motion/tokens.ts`, `radar.ts`. All pure
  functions. `packages/ui/src` contains **21 `.tsx` components**.
- **Test covering it:** `packages/ui/test/coach-panel-render.test.ts` — the only rendering test in
  the repo. It compiles the package with `tsc` into a temp directory, imports the emitted module,
  renders `CoachPanel` with `renderToStaticMarkup`, and asserts that no percentage in the output
  exceeds 100%. That is a genuinely excellent test.
- **Reviewer notes:** **1 of 21 components is rendered by any test.** `PokerTable`, `Seat`,
  `ActionBar`, `TurnTimer`, `PlayingCard`, `RadarChart`, `EquityBar`, `Reveal`, `CardRow`,
  `PotDisplay`, `StatTile`, `Metric`, `Formula`, `Callout`, `Panel`, `Button`, `Chip`,
  `UncertaintyNote`, `UnitsBadge`, `AssumptionList` are never rendered. The 99.08% figure describes
  the 22% of the package that is pure functions. And see TEST-011: because
  `coach-panel-render.test.ts` uses hand-written literal fixtures, the 160% value that *is* in the
  shipped data slips past the one guard built to catch exactly it.
- **Missing work:** extend the render harness to the remaining components; render at least one
  panel from the *shipped* fixture data rather than only from literals.

---

### TEST-023 Critical module coverage — release-gating scripts

- **Status:** **FAIL**
- **Implementation location:** `scripts/` and `scripts/supply-chain/`
- **Runtime evidence:** exactly **one** test file exists for 12+ scripts:
  `scripts/supply-chain/policy-check.test.mjs` (7 tests, all pass). Untested:
  `scripts/supply-chain/{audit,deny-list,dep-shapes,ioc-scan,lib,lockfile-integrity,osv-scan,provenance,quarantine,repo-hygiene,sbom,denied-packages}.mjs`,
  plus `scripts/{a11y-audit,check-contrast,clean,db-wait,dev,load-test,smoke-test}.mjs`.
- **Reviewer notes:** `security:audit` is the **gate job** in CI — every other job `needs:` it
  (`.github/workflows/ci.yml:83`). Twelve of the thirteen supply-chain gates that decide whether
  the release is safe have no tests of their own. A gate that silently passes because of a bug in
  the gate is indistinguishable from a clean audit; that is the same defect class this whole
  workstream is about, applied to the security tooling. `scripts/load-test.mjs` (1,087 lines) and
  `scripts/smoke-test.mjs` (715 lines) are also untested — the repo's own comment at
  `apps/api/test/harness-paths.test.ts:5-16` records that `test:load` "had never once worked"
  because three route constants were wrong, and the fix was a *static* path-extraction test, not a
  test of the harness.
- **Missing work:** unit tests for at least the gates that can fail open (`deny-list`, `osv-scan`,
  `ioc-scan`, `lockfile-integrity`, `repo-hygiene`) with fixtures that must be rejected.

---

### TEST-024 Long-running suites are real evidence

- **Status:** PASS
- **Runtime evidence:**

```
$ pnpm run test:exhaustive
✔ the expected frequencies sum to C(52,7) (0.409916ms)
✔ EXHAUSTIVE: all 133,784,560 seven-card hands classify to the published frequencies (6978.7ms)
ℹ tests 2  pass 2  fail 0

$ pnpm run test:simulation      (run twice)
ℹ tests 23  pass 23  fail 0   duration_ms 192078.9   /   151298.3
```

- **Reviewer notes:** `packages/poker-engine/test/exhaustive/seven-card-distribution.test.ts:37-49`
  asserts against the true published 7-card frequencies (23,294,460 / 58,627,800 / 31,433,400 /
  6,461,620 / 6,180,020 / 4,047,644 / 3,473,184 / 224,848 / 41,584) — independently derived, not
  copied from this code, and cross-checked by a second test that they sum to C(52,7). This is the
  single best test in the repository.
  `packages/poker-ai/test/simulation/profile-differentiation.test.ts:1-90` derives its tolerances
  from sampling theory (`1.96 × 0.5 / √8000 = 0.011`, tolerance 0.05) and documents a sensitivity
  sweep. One caveat: the VPIP tolerance is imported from `OBSERVABLE_AXES` in *source*
  (`packages/poker-ai/src/stats.ts`), so the same constant is both the product's declared accuracy
  and the test's pass bar — widening it in source silently widens the test. That is a circularity,
  though a documented and defensible one.
- **Missing work:** none blocking. Neither suite is in `pnpm run test`; both have their own CI job.

---

### TEST-025 Named negative / failure-mode cases for critical logic

- **Status:** PARTIAL
- **Runtime evidence / specific untested failure modes:**
  1. **Pot refund when no player is live** — `packages/poker-engine/src/pots.ts:80-88`, uncovered.
     Everyone folds/busts such that `live.length === 0`; all commitments are returned. Never
     exercised.
  2. **Live-table → Postgres persistence failure** — `postgresArchive` (registry.ts:137-197) is
     never called by a test at all, so neither its happy path nor any SQL error inside it is
     covered. A hand that fails to persist mid-write has no test.
  3. **Migration failure / rollback / re-run** — no test (TEST-020).
  4. **Fake-vs-SQL store divergence** — no conformance test for `RoomStore` or `AuthStore`
     (TEST-010, TEST-017).
  5. **The no-database waiver path** — untested, and broken (TEST-005).
  6. **Supply-chain gates failing open** — no gate has a "must reject this bad input" fixture
     except `policy-check` (TEST-023).
  7. **Coach output exceeding a probability of 1 in shipped data** — the guard exists but is fed
     literals, not the shipped fixtures (TEST-011/TEST-022).
  8. **`apps/web` error paths** — `lib/api.ts` has 507+ lines of HTTP error handling and zero
     coverage (TEST-021).
- **Reviewer notes:** Where negative cases exist they are good: `assert.throws`/`assert.rejects`
  appears 350+ times, `packages/poker-math/test/variance.test.ts` has 41,
  `stacks.test.ts` 34, `ev.test.ts` 33, `odds.test.ts` 31, `icm.test.ts` 29. The gaps are
  structural (whole modules with no tests), not local.

---

### TEST-026 No flaky timing assumptions

- **Status:** PARTIAL
- **Implementation location:** `apps/api/test/shutdown.test.ts:236-241`, `:278`, `:283`, `:328`,
  `:352-357`; `apps/api/test/ws-socket.test.ts:398`, `:504`, `:528`
- **Runtime evidence:** `setTimeout` appears in exactly two test files (5 uses in `shutdown.test.ts`,
  3 in `ws-socket.test.ts`). No `sleep()` helpers, no polling loops, no port-collision risk
  (`ws-socket.test.ts` and `shutdown.test.ts` bind ephemeral ports). Across 3 full runs plus 3
  no-database runs, none of these flaked.
- **Reviewer notes:** The wall-clock assertion is `assert.ok(exit.elapsedMs < budgetMs)` with
  `budgetMs = GRACE_MS / 3 = 1,500 ms` (`shutdown.test.ts:46`, `:226`, `:238`) and a trailing-exit
  bound of `< 1_000 ms` (`:353`). Both are absolute wall-clock budgets on a spawned Node process;
  on a heavily loaded CI runner these are plausible flake sources. Mitigating: the suite is
  carefully written to fail rather than pass vacuously — `shutdown.test.ts:329-335` asserts
  `answeredBeforeSignal === false` with the message *"the calculation finished before the signal,
  so this run proved nothing about a request in flight"*, which is exactly the right instinct.
  Fixed sleeps of 200/150/120 ms at `:278`, `:283`, `:328` are setup delays, not assertions.
- **Missing work:** none observed empirically; flag the 1,500 ms budget as the first place to look
  if CI ever goes intermittently red.

---

## Counts

| Status | Count |
|---|---|
| PASS | 11 |
| FAIL | 10 |
| PARTIAL | 5 |
| UNVERIFIED | 0 |
| N/A | 0 |

---

## Severity-classified issues

### P0 — release catastrophe

1. **A 160% probability ships to learners on the Scenario Lab page, and the test that would catch
   it is red and never reaches it.** `apps/web/src/fixtures/scenarios.ts` scenario
   `flop-spr-commitment` carries `ruleOfThumb.estimate: 1.6`; `CoachPanel.tsx:647` renders
   `formatPercent(1.6)` → "160.0%"; the current engine refuses to emit it
   (`coach.ts:274-278`, `:375-382` return `null` / throw). Three of six shipped scenarios and one
   of two shipped review hands disagree with the engine. `apps/api/test/web-fixture-figures.test.ts`
   aborts on the first mismatch and never names this one. *(TEST-011)*
2. **`pnpm run test` currently exits 1 — deterministically, 3/3 runs — and CI runs that exact
   command.** Not a stale build: I recompiled `poker-math` to a scratch dir and the emitted JS is
   byte-identical to `dist/` apart from the sourcemap comment. *(TEST-001)*

### P1 — required capability broken or unproven

3. **86% of the "integration" suite never touches Postgres**, and the two production persistence
   adapters — `postgresRoomStore` (registry.ts:264) and `postgresArchive` (registry.ts:137) — have
   **zero** coverage. No test ever plays a hand at a live table and reads it back out of the
   database. *(TEST-010, TEST-019)*
4. **The reachability guard does not do what it claims.** A package whose `test` script is
   `echo … && exit 0`, or whose only test file has no `test()` calls, or whose only suite is
   `describe(…, { skip: … })`, all pass the guard while executing nothing — and node reports
   `tests 0 / skipped 0` and exits 0. Demonstrated in a scratch copy. *(TEST-003)*
5. **The documented no-database waiver `pnpm run test:no-database` fails**, and has never worked:
   `shutdown.test.ts` spawns a server that refuses to boot without `DATABASE_URL` and carries no
   `databaseSkip` guard. *(TEST-005)*
6. **The migration runner (28 KB) and schema verifier have no tests at all.** *(TEST-020)*
7. **`apps/web` has effectively no test coverage**: 2 of ~63 source files ever loaded; 118 of 123
   exported symbols never named in a test; zero component or page rendering tests. *(TEST-021)*

### P2 — significant quality gap

8. **12 of 13 supply-chain gate scripts — the CI gate every other job depends on — are untested.**
   *(TEST-023)*
9. **1 of 21 UI components is ever rendered by a test**; `packages/ui`'s 99.08% coverage figure
   describes only its pure-function files. *(TEST-022)*
10. **Non-execution is invisible in the summary**: with the DB absent, 77 tests do not run and the
    runner prints `skipped 1`. *(TEST-006)*
11. **No conformance testing between fake and SQL store implementations** for `RoomStore` and
    `AuthStore`; auth session lifecycle is proven against a `Map`. *(TEST-010, TEST-017)*
12. **`packages/contracts`: 100% line, 8.11% function coverage** — the tests evaluate the module
    rather than exercise it. *(TEST-009)*
13. **15 of 78 test files are static source-text scans**, not behavioural tests. Legitimate as
    lint, but they should not be cited as runtime evidence. *(TEST-009)*
14. **The `pots.ts` full-refund branch (no live players) is never executed.** *(TEST-015, TEST-025)*

### P3 — polish

15. The repo repeatedly claims "**57** database tests" (`helpers/database.ts:11`,
    `database-availability.test.ts:5`, `:89`, `.github/workflows/ci.yml:284`). The measured figure
    is **77**. *(TEST-002)*
16. Two `assert.doesNotThrow`-only tests with no outcome assertion:
    `packages/poker-ai/test/opponent-model.test.ts:618-623` and `:727`. *(TEST-009)*
17. The simulation tolerance is imported from source (`OBSERVABLE_AXES` in
    `packages/poker-ai/src/stats.ts`), so widening it in source silently widens the test's pass
    bar. *(TEST-024)*
18. `shutdown.test.ts`'s 1,500 ms absolute wall-clock budget is the most plausible future CI flake.
    *(TEST-026)*

---

## What the green checkmark is worth, in one paragraph

There is no green checkmark: `pnpm run test` exits 1 today. Behind that, the suite is unusually
honest in the areas it covers — 4,930 assertions, zero `.skip`/`.todo`, zero TODO markers, one
unsafe cast in 78 files, no mock-call assertions, a genuinely exhaustive 133,784,560-hand
enumeration against published frequencies, 96%+ branch-aware coverage of the poker engine and math,
and a database guard that really does fail loudly. What it is *not* is evidence about the shipped
product: 86% of the "integration" suite runs against in-memory fakes, the production Postgres
adapters and the migration runner have zero coverage, `apps/web` has 2 of 63 source files under
test and no rendering harness, 12 of 13 release-gating security scripts are untested, and the one
suite that checks the data the web app actually ships is red — hiding a 160% probability on a
teaching page. Cite the engine and math tests freely. Do not cite the API suite as proof that
anything works against a database, and do not cite anything at all as proof that the web client
works.
