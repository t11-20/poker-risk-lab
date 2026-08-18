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

**13 web routes:** `/`, `/learn`, `/learn/[lessonId]`, `/learn/glossary`, `/lab`,
`/lab/[scenarioId]`, `/play`, `/legends`, `/legends/[profileId]`, `/legends/compare`,
`/legends/hand-review`, `/review`, `/review/[handId]`.

**8 API route modules:** auth, calc, content, hands, legends, progress, rooms, plus the
router index that mounts them under `/api/v1`.

**Scale:** 217 source files (79,668 lines) and 80 test files (36,128 lines) — 0.45 lines of
test per line of source.

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
pnpm run verify          # security:audit → hygiene → lint → build → typecheck → test
pnpm run test            # unit + integration + scripts
pnpm run test:all        # the above, plus exhaustive, simulation and a11y
pnpm run security:audit  # 8 supply-chain gates
pnpm run test:exhaustive # all 133,784,560 seven-card hands
pnpm run test:simulation # AI profiles vs their published cards
pnpm run test:smoke -- --strict
pnpm run test:load
pnpm run db:verify       # asserts the LIVE schema's security properties
pnpm run design:contrast # WCAG 2.2 AA, both themes
```

`build` precedes `typecheck` deliberately: every `@prl/*` package resolves its types through
`dist/`, so typechecking a clean install first cascades into TS2307 across seven projects.

### What the correctness claims rest on

The discipline throughout was that a claim must be checked against ground truth the code has
no access to, not against itself.

- **The hand evaluator** is checked by enumerating all **133,784,560** seven-card hands and
  comparing category frequencies to the published combinatorial result. A single
  misclassified hand moves at least two counters and fails.
- **Equity** is checked against published figures — AA vs KK over all 36 suit configurations
  gives 81.946% against a published ~81.9%.
- **The engine** is checked by a randomised soak of 20,000 hands / 167,987 decision points
  asserting exact chip conservation and that every pot goes to an entitled seat.
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
  Fisher–Yates drawing from `[0, i]`. `Math.random` is banned across all 8 source trees by a
  scan wired into the release gates.
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

This build was subjected to an adversarial multi-agent release review: seven independent
reviewers running their own checks in parallel, none permitted to rely on the implementer's
summary. **All seven returned FAIL**, with 94 findings deduplicated into 15 blocking clusters.

The most consequential finding was not a crash. It was that the Coach computed a raise's
expected value as though it were an opening bet — an error of exactly `(1−f)·C·(1−e)`, always
positive, and worse the lower the player's equity. It changed 6 of 35 shipped scenario
recommendations, 5 of them from *raise* to *fold*. Everything else in the review was something
that did not work; that was something that worked, presented itself as authoritative, and was
wrong.

The second most consequential was structural: the web application was not connected to the API
at all. Every request omitted the `/api/v1` prefix, and a 404 was treated as "API not
deployed", so every screen silently served bundled fixtures. It rendered correctly, which is
why internal verification kept passing.

Full detail: `reviews/release-findings.md` (all findings, with the reviewers' disagreements
preserved rather than averaged) and `reviews/final-release-report.md` (the release decision).
