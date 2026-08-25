# Poker Risk Lab — delivery report

An educational, play-money No-Limit Texas Hold'em application for teaching probability,
pot odds, expected value, variance and decision quality.

> **This is not gambling software.** There is no real money, no purchase, no cash-out, no
> transferable chip, no prize and no crypto anywhere in it. Units are free, resettable and
> valueless. The guardrails are enumerated in `PRODUCT-GUARDRAILS.md` and several of them
> are enforced by tests rather than by intention.

---

## 1. What was built

A pnpm workspace of six libraries and two applications.

| Package | What it is | External runtime deps |
|---|---|---|
| `@prl/poker-engine` | Pure rules engine: deal, betting, side pots, showdown, redaction, deck commitment | none |
| `@prl/poker-math` | Equity, outs, pot odds, EV, fold equity, variance, the Coach | none |
| `@prl/poker-ai` | Opponent models, difficulty settings, simulation, commentary | none |
| `@prl/contracts` | Wire types, JSON schemas, WebSocket protocol, the API path table | none |
| `@prl/content` | Lessons, quizzes, glossary, scenarios, and their validators | none |
| `@prl/ui` | Design tokens and shared React components | react, react-dom |
| `@prl/api` | Fastify 5 REST + WebSocket server, PostgreSQL persistence | fastify, @fastify/*, postgres, ws |
| `@prl/web` | Next.js 16 App Router client | next, react, react-dom |

**19 web routes** (`find apps/web/src/app -name page.tsx`): `/`, `/learn`,
`/learn/[lessonId]`, `/learn/glossary`, `/lab`, `/lab/[scenarioId]`, `/play`, `/legends`,
`/legends/[profileId]`, `/legends/compare`, `/legends/hand-review`,
`/legends/hand-review/demo`, `/review`, `/review/[handId]`, `/record`, `/age-check`,
`/privacy`, `/terms`, `/responsible-use`. This said thirteen and listed thirteen; the six it
was missing are the ones added since — the hand-review demo, the recorder, and the four
age-gate and legal pages, which are exactly the routes a reader auditing the compliance
surface would come here to find.

**8 API route modules:** auth, calc, content, hands, legends, progress, rooms, plus the
router index that mounts them under `/api/v1`.

**Scale.** Run the two commands below rather than citing a number from this page. They are given
as commands because the counts move with every commit — measured twice on 2026-08-19, an hour
apart, they read 214/103 and then 216/108 — and a frozen count in a document nobody re-derives is
the smallest possible version of the problem this report has now been corrected for three times.
The order of magnitude is what the sentence is for: roughly two hundred first-party source files
against roughly a hundred test files.

```bash
find apps packages -path '*/src/*' -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
  ! -path '*/dist/*' ! -path '*/node_modules/*' | wc -l          # source files
find . -name '*.test.*' ! -name 'tsconfig*' ! -path '*/dist/*' \
  ! -path '*/node_modules/*' | wc -l                             # test files
```

---

## 2. Versions

Pinned exactly; the lockfile is the authority and `--frozen-lockfile` is enforced.

| | |
|---|---|
| Node | 24.18.0 (native TypeScript type-stripping; `node --test` is the only test runner) |
| pnpm | 11.10.0, pinned in `packageManager` with a sha256 integrity hash |
| TypeScript | 7.0.2, strict, plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly` |
| Next.js | 16.3.0 |
| React | 19.2.8 |
| Fastify | 5.11.3 |
| PostgreSQL | 16 (container) |
| Biome | 2.5.7 (lint + format) |
| axe-core | 4.13.0 (static accessibility audit) |
| postgres (porsager) | 3.4.9 |
| ws | 8.21.3 |

The entire repository has **four root devDependencies** — Biome, `@types/node`, axe-core and
TypeScript. No test framework, no assertion library, no mocking library, no animation
library, no CSS framework, no charting library. Every dependency is exact-pinned; there are
no `^` or `~` ranges, no git or tarball specifiers, and no `npx`/`pnpm dlx` anywhere.

---

## 3. How to run it

```bash
cp .env.example .env                 # then set SESSION_COOKIE_SECRET
pnpm install --frozen-lockfile
pnpm run db:setup                    # docker compose + migrate + seed
pnpm run build
pnpm run dev                         # api on :3001, web on :3000
```

Visit `http://localhost:3000`. Use `localhost`, not `127.0.0.1` — they are different origins
to a browser, and while both are now in the allowlist, only `localhost` was historically.

**Deployment** is `docker compose up -d`, which publishes **one** origin: a reverse proxy.
The browser sends relative `/api/*` paths and never learns the API's address. Retargeting is
`PRL_PROXY_API_UPSTREAM`, applied on container replacement — **not** a rebuild. Full
procedure, including the one-API-process rule, is in `RUNBOOK.md`.

> **The one-API-process rule.** Room state is in memory, so a room lives in exactly one
> process. Run one API process, or route with room affinity. This is the single most
> important operational constraint and it is not enforced by code.

---

## 4. Verification

```bash
pnpm run verify          # the release gate: 14 gates, every one of them run and reported
pnpm run test            # build:packages, then unit + integration + scripts
pnpm run test:all        # the above, plus exhaustive, simulation, a11y and ax
pnpm run security:audit  # 11 supply-chain gates
pnpm run test:exhaustive # all 133,784,560 seven-card hands
pnpm run test:simulation # AI profiles vs their published cards
pnpm run test:smoke -- --strict
pnpm run test:load
pnpm run db:verify       # asserts the LIVE schema's security properties, ownership included (check 6b)
pnpm run design:contrast # WCAG 2.2 AA, both themes
pnpm run fixtures:check  # the web fixtures still equal what the engine computes
```

`verify`'s gates, in order:

```
security:audit · security:hygiene · lint · build · typecheck · design:contrast
test · test:a11y · test:ax · test:csp · test:age-gate · test:exhaustive · test:simulation
db:verify
```

Fourteen. This list said eleven, then thirteen. The eleven omitted `test:ax` and `test:csp`, which
were in the loop all along; the thirteen was right until `test:age-gate` was added to it. The
authority for this list is the loop in `package.json`, not this block.

**Every gate runs even if an earlier one fails**, each prints `PASS`/`FAIL`, and the command exits
non-zero if any failed. `verify` used to be a `&&` chain with `db:verify` last — so while `test` was
red, the gate described two lines above as asserting the live schema's security properties **had
never executed inside the command this document tells operators to run**. It passed on its own,
which is precisely why that went unnoticed for so long. `test:a11y` was in no gate at all;
accessibility is a stated functional requirement, so it is one now.

`build` precedes `typecheck` and `test` deliberately: every `@prl/*` package resolves its types and
its runtime exports through `dist/`, so typechecking a clean install first cascades into TS2307
across seven projects, and *testing* a clean install silently tests the previous build or nothing at
all. `test` therefore builds the packages itself — `dist/` is `.gitignore`d, so a suite that depends
on it is not hermetic unless it produces it.

### What the correctness claims rest on

The discipline throughout was that a claim must be checked against ground truth the code has
no access to, not against itself.

- **The hand evaluator** is checked by enumerating all **133,784,560** seven-card hands and
  comparing category frequencies to the published combinatorial result. A single
  misclassified hand moves at least two counters and fails.
- **Equity** is checked against published figures — AA vs KK over all 36 suit configurations
  gives 81.946% against a published ~81.9%.
- **The engine** is checked by three randomised soaks totalling **8,500 hands / 50,236 applied
  actions** — 4,000 general-invariant hands (27,233 actions), 1,500 shove-heavy (6,847) and 3,000
  short-blind-heavy (16,156) — asserting exact chip conservation after every action and that every
  pot goes to an entitled seat. Each soak also asserts its own coverage, so a generator that
  degenerated into folding every hand fails rather than passing quickly.
- **The Coach's EV** is checked against hand-derived closed forms written as literals in the
  test, with the derivation in a comment, and every size it can emit is cross-checked
  against the engine's own legality rules.
- **AI profiles** are checked against their declared cards over large deterministic
  simulations, using a statistic the test derives itself rather than importing.
- **Hidden information** is checked over a live socket with two sessions at one table, by
  inspecting every frame each receives against the server's own deal.

### Test-suite integrity

A guard (`workspace-test-reachability.test.ts`) asserts that every workspace `test*` script
and every `*.test.*` file is reachable from a documented root command, and that no package's
suite can report `tests 0`. This exists because the failure it prevents actually happened:
56 database tests — including the six asserting that one player can never receive another
player's hole cards — silently skipped while the suite exited 0.

An audit then defeated the first version of that guard three ways, so it now checks execution and
not only reachability: a workspace `test` script must **be** a `node --test` runner (an
`echo … && exit 0` used to be exempted from the zero-tests check entirely), every `*.test.*` file
must declare at least one `test()`/`it()`, and no declaration may be disabled by a literal
`{ skip: '…' }` — node reports those as `tests 0 / skipped 0`, so a green run never mentions them. A
skip whose value is an *identifier* is still allowed, because that is the conditional no-database
waiver, and `database-availability.test.ts` fails inside it whenever `CI` is set. Each of the three
bypasses has a negative control that builds it in a temporary directory, proves `node --test` exits
0 on it, and proves the guard reports it.

A missing database now **fails** with a message naming `pnpm run db:setup`. The only waiver
is a named script that prints a banner saying the run proves nothing about SQL, and it is
**refused whenever `CI` is set**.

---

## 5. Security posture

Full detail in `SECURITY.md` and `THREAT-MODEL.md` (16 threats, plus §9 on accepted gaps).

- **Server authoritative.** Clients express intent only. No client message names a card, a
  stack, a pot, a turn order or a legal action.
- **Redaction by construction.** `PlayerView` is built field-by-field from server state
  rather than by deleting fields from a fuller object, so it fails closed.
- **Randomness** is cryptographic, with rejection sampling for an unbiased `unbiasedInt` and
  Fisher–Yates drawing from `[0, i]`. `Math.random` is banned across every first-party `src/` tree
  by a scan wired into the release gates — **eight** trees: `apps/api`, `apps/web` and the six
  packages. `pnpm run security:hygiene` prints the file count it covered; read that line rather
  than a number here, because it moves with every commit (it changed twice in one afternoon while
  this report was being corrected). The scan has its own negative control, feeding the detector a
  violation and a prose mention and failing if it cannot tell them apart.
- **Deck commitment** is a per-card Merkle tree with domain-separated leaf/node hashing and
  32-byte per-card salts, so a post-hand reveal proves the deal without exposing cards that
  were never shown. (The first design hashed the whole deck and leaked folded hands.)
- **Supply chain:** frozen lockfile, `ignoreScripts: true`, `onlyBuiltDependencies: []`, a
  7-day registry cooldown (`minimumReleaseAge`), store integrity verification, isolated
  node-linker, a Mini Shai-Hulud denylist and IOC sweep, OSV scanning and a CycloneDX SBOM.
  All policy lives in `pnpm-workspace.yaml` — **pnpm 11 reads only auth and registry settings
  from `.npmrc`**, so policy placed there is silently inert, and a gate fails if any appears
  there.
- **Transport:** secure cookies with `__Host-` prefix, CSRF double-submit, strict WebSocket
  Origin checking, JSON schemas on every route, address-keyed rate limits on session-minting
  routes, parameterised SQL throughout, least-privilege database roles, redacted logs.

---

## 6. Known limitations

Stated plainly. Several of these are things the automated suite cannot detect.

1. **No browser harness in CI.** The two tests that would catch the frontend defects found in
   review — a viewport occlusion hit-test and a keyboard focus-trap walk — cannot run there.
   `test:a11y` is a **static** audit of server-rendered HTML, and the layout guard asserts CSS
   properties *textually*. Neither can observe that one element covers another.
2. **`notFound()` inside a page returns 404 with an empty HTML body.** Content is present only
   in the RSC payload. This is Next 16's `errorRecovery` path; unmatched URLs are unaffected,
   and both app-level workarounds are worse than the symptom.
3. **`observed` (a learner's own measured tendencies) is `null`.** It is not simulated into,
   deliberately. Three concrete blockers are documented: `room_members.bot_profile` cannot
   identify 7 of 12 profiles in durable rows; `bluffFrequency` asks what a bet was made with,
   which a public observer cannot see; and the observer needs a `raiseWasAvailable` column
   that `hand_actions` does not have.
4. **`pressureTendency` and `barrelPersistence` are documented as "how much" but applied to
   "how often".** All profiles pass their declared axes, but `disciplined-specialist` has only
   0.042 of margin against a ~0.08 sampling half-width, so a future seed could flip it. Cause
   localised and monotone across the profile set; recorded as REM-1.
5. **WebSocket heartbeat termination is untested.** It needs an injectable clock in `hub.ts`;
   testing it as-is would add 30+ seconds to every run.
6. **Load numbers are not capacity numbers.** `test:load` is a loopback, single-process,
   dev-database harness. It detects concurrency regressions. Any sentence of the form "we
   measured N concurrent players" that traces back to it is wrong.
7. **Two advisory complexity warnings** remain in `packages/content/src/validate.ts`.
8. **AI Legends are educational strategy simulations**, not the real players. See §7.
9. **The release verdict is FAIL and no independent round has been run since remediation.** §8.
   Reading the source and seeing a repair is not the same as verifying it, and this project has
   been caught making that substitution twice.
10. **Both halves of this item have been closed, and it is kept because it was load-bearing.**
    It read: "Nothing in the repository restores a backup, and `db:verify` does not check schema
    ownership" — the `RUNBOOK` §11.4 procedure was rehearsed by hand and enforced by no gate, and
    the command the checklist says to trust as the rehearsal exited 0 on a database whose 54
    relations were owned by the runtime role, because it asked whether `prl_app` owned anything
    and never asked who did. Measured 2026-08-19. Since then: `apps/api/scripts/verify-schema.mjs`
    gained **check 6b**, which asserts that schema `prl` and every relation in it are owned by
    `prl_migrator` and names the offenders when they are not; and `scripts/backup.mjs` gained
    **`restore`** (into a named target, never over the live database without an explicit flag) and
    **`verify --deep`**, which restores into a scratch database and compares row counts rather than
    checking a sha256 sidecar and calling that a restore. `deploy/backup/prl-backup-verify.timer`
    runs the verification on a schedule, because a backup nobody restores is a directory of files
    with an encouraging name. **What remains true:** none of this is in `pnpm run verify` — a
    restore is not a release gate — and `verify --deep` proves `pg_restore` can read the archive,
    not that the application serves the restored data. That drill is
    [`production/backup-restore.md`](production/backup-restore.md) §7.
11. **A pinned digest is not a safe digest.** The new `ci-pinning` gate proves every action and
    base image is referenced immutably. It cannot say the artefact was benign when the digest was
    taken, and the OSV gate queries the npm ecosystem only, so an advisory against a base image
    reaches this repository through a human.
12. **The roll-forward gate's wiring is untested.** `apps/api/scripts/migrate.test.mjs` proves the
    destructive-statement scanner works and that `down` refuses. Nothing proves `up` consults the
    scanner before applying, because that needs a live database and a deliberately bad migration.

---

## 7. AI Legends — what they are and are not

The opponent models are **educational strategy simulations based on publicly documented play
patterns**. They are **not** the real players, not digital twins, not endorsed, and not
affiliated. They never reproduce anyone's private thoughts, quotes or beliefs.

- The naming default is **generic archetype**. Attributed naming is an explicit opt-in
  (`PRL_LEGEND_NAMING=attributed`), and the archetype default holds even when the client is
  running on bundled data with no server.
- Commentary says *"this model prefers…"*, never *"<name> thinks…"*. A guard rejects
  mental-state verbs attached to a name, and gendered pronouns, because the commentary
  describes a model rather than a person.
- Behaviour is **probabilistic, not scripted** — controlled randomness, no hard-coded actions.
- The AI reads only what a human in the same seat could read. It has no access to hidden
  cards or future deck state, and a test asserts this over the model's actual input.
- Strategy quality is reported separately from hand outcome, because the product's whole
  point is that good decisions lose in the short run.

---

## 8. Review and release

This build has been through **two** independent adversarial rounds, and neither has yet returned a
verdict that would permit a release. Both are recorded here, in order, because a report that
describes only the round it survived is a report nobody should trust.

**Round 1 — release review.** Seven independent reviewers running their own checks in parallel, none
permitted to rely on the implementer's summary. **All seven returned FAIL**, with 94 findings
deduplicated into 15 blocking clusters.

The most consequential finding was not a crash. It was that the Coach computed a raise's
expected value as though it were an opening bet — an error of exactly `(1−f)·C·(1−e)`, always
positive, and worse the lower the player's equity. It changed 6 of the 36 shipped scenario
recommendations, 5 of them from *raise* to *fold*. Everything else in the review was something
that did not work; that was something that worked, presented itself as authoritative, and was
wrong.

The second most consequential was structural: the web application was not connected to the API
at all. Every request omitted the `/api/v1` prefix, and a 404 was treated as "API not
deployed", so every screen silently served bundled fixtures. It rendered correctly, which is
why internal verification kept passing.

**Round 2 — independent release audit, 2026-08-18.** Eight reviewers under a single barrier plus a
final challenger behind an information wall, tasked with disproving the product. **Verdict: FAIL.**
208 requirements traced, 143 PASS, 31 PARTIAL, 33 FAIL, 1 UNVERIFIED; **4 P0 clusters and 17 P1
clusters**. Its own summary of what it found good is worth as much as its findings, and both are in
`audit/final-release-audit.md`. Several of its findings were about this document and the runbook
rather than the product — numbers stated with more confidence than the evidence supported, and a
graceful-shutdown behaviour the runbook called "fixed" that was not.

### Round 2 remediation — in progress, and not a clearance

Remediation began 2026-08-18 and is still under way as this section is written (2026-08-19). It is
recorded here at the level of evidence rather than as a list of ticks, because the audit's most
repeated criticism was of exactly that: work reported complete on weaker evidence than the report
implied.

**What has been fixed, with what I checked myself.** Every item below was re-run for this
paragraph; the numbers are that run's output, not a carry-forward.

| Audit finding | State | How that was established |
|---|---|---|
| **P0-4** `verify` was a `&&` chain, so `db:verify` had never executed inside it | Fixed | `verify` is now a loop over its whole gate list — fourteen gates today, and the number is not the finding — that prints `PASS`/`FAIL` for each, runs all of them regardless, and exits 1 listing every failure. Read from `package.json`; the control flow was executed with stand-in gates and two deliberate failures — both were reported and the exit was 1 |
| **OPS-015** `RUNBOOK` §11.4 backup/restore produced an unservable database | Fixed | Rehearsed end to end 2026-08-19. The old `--no-owner --no-privileges` restore exits **0** and then `db:verify` exits **1** with `prl_app: lacks USAGE on schema prl`. The corrected procedure — `migrate.mjs roles`, then `pg_restore --exit-on-error` with ownership kept — gives `db:verify` exit 0 and `db:migrate:status` exit 0 |
| **OPS-008** the least-privilege database model was never exercised | Fixed | `docker-compose.yml` and `.env.example` connect as `prl_api`; `db/seeds/0002_dev_login_roles.sql` creates it as a member of `prl_app` and asserts it holds `USAGE` and not `CREATE` on schema `prl` |
| **OPS-003** no rollback path and no roll-forward-only policy in its place | Fixed | `migrate.mjs down` refuses and lists four alternatives (run, exit 1); `up` refuses an undeclared destructive statement; `apps/api/scripts/migrate.test.mjs` covers it, 10/10 pass |
| **SUP** no gate enforced CI action SHA or base-image digest pinning | Fixed | A ninth audit gate, `ci-pinning`. Run 2026-08-19: 24 action references, 2 Dockerfile base images, 2 compose images — all pinned, pass |
| **SUP-018** `audit.mjs --offline` exited 0 with two gates unrun | Fixed | Now exits **2** |
| **P0-2** the shipped web fixtures published a `1.6` estimate rendered as "160.0%" | Fixed | `scripts/regenerate-web-fixtures.mjs` now exists — it did not before, which is why the guard's stated remedy was not executable — and `pnpm run fixtures:check` reports `web fixtures are already the analysis the engine produces today`, exit 0 |
| **LEAD-007** the project was not under version control | Fixed | Two commits: the audited baseline, then the first remediation pass |
| **P2** documentation overclaims (20,000-hand soak, "6 of 35" scenarios, stale coverage figures, "19 tests", "25 identity checks", "8 gates") | Fixed | Every figure in `VERIFICATION.md` re-measured 2026-08-19 by running the test that produces it. §1 above now gives commands instead of constants |

**Two corrections to the audit itself, and one thing it missed.**

* The audit recorded *"8 source trees where the scan says seven"*. The scan says **eight**, and
  there really are eight (`apps/api`, `apps/web`, and six packages). What was stale was inside
  the gate: a comment reading "Seven trees today" and a `trees.length < 7` lower bound that had
  been left behind by the tree it counts. The bound is a floor, so it never fired. Cite the line
  the gate prints — `scanned 200 source files across 8 src/ trees` — not a constant in a document.
* `docs/reviews/final-release-report.md`, which the audit correctly reported as missing while
  being cited as "the release decision", now exists.
* **Not in the audit, found while rehearsing the restore:** `pnpm run db:verify` **cannot see a
  wrongly-owned schema**. Restoring a dump as `prl_api` without `--exit-on-error` leaves all 54
  relations in schema `prl` owned by `prl_api` — which then holds `CREATE` on the schema and can
  `DROP` every table it serves — and `db:verify` exits **0**, because check 6 asks whether
  `prl_app` owns anything and never asks who does. The one command the checklist says to trust as
  the restore rehearsal was blind to this restore. Check 6b in `verify-schema.mjs` now closes it, and caught a real wrongly-owned ledger on first run. Recorded in `VERIFICATION.md` §12 and
  `RUNBOOK.md` §11.4; the fix is one query in `apps/api/scripts/verify-schema.mjs`.
* **Not in the audit, found while re-deriving `VERIFICATION.md` §8:** two equity figures were
  quoted as the *extreme* suit configuration and placed beside an *average*, which reads as an
  average. `AKo` vs `QQ` averages **43.24%** across its 72 configurations, not the 42.84% given
  (that is the minimum); `AKs` vs `22` averages **49.89%**, not 50.08% (the maximum). Both are
  corrected in place, and §12 now records that **no test reproduces any of those figures** — the
  nearest gated assertion bounds a single configuration to 0.80–0.84.

**What is not established here.** P0-1 (the Coach's legality guard failing open) and P0-3 (graceful
shutdown killing every WebSocket) both show clear evidence of repair in the source —
`CoachTask.legalActions` is now a required field, and `shutdown.test.ts` now contains WebSocket
cases where the audit found none — but **that is reading, not verification**, and reading is what
the audit repeatedly caught this project doing. Neither is claimed as fixed by this document. The
same applies to the seventeen P1 clusters: several are being worked on in parallel with this
section, so any status written here would be a status at a moment that has already passed.

**The verdict has not changed, and nothing above changes it.** No independent round has been run
against the remediated tree. `reviews/final-release-report.md` still reads **do not ship**, and
under its own rule it changes only when a decision changes — not when work is done. Its bar
includes a third independent round by reviewers who did not do the remediation, and that has not
happened.

Full detail: `reviews/release-findings.md` (round 1: all findings, with the reviewers'
disagreements preserved rather than averaged), `audit/` (round 2: the summary, the per-requirement
traceability matrix, and the reviewers' raw records), and `reviews/final-release-report.md` — the
release decision, which is currently **do not ship**, and says what would have to change.
