# Branch handover — `production-hardening-2`

**State:** the branch is many commits ahead of `main`; run the two commands below rather than
trusting a number here.

```bash
git rev-list --count main..HEAD    # commits on this branch
git diff --shortstat main..HEAD    # files and lines changed
```

*This file quoted its own commit count twice and was wrong both times — once off by one the moment
it was committed, and again six commits later. A figure that every subsequent commit invalidates,
including the commits correcting it, is a figure that should not be written down. The commands are
the answer; that they replaced a number here is the first worked example of this document's closing
advice.*

**Gate:** `pnpm run verify` — **16 of 16, exit 0**. For the test count, run it; the figure here was stale within a day, twice, for the reason argued above.
**Deployment:** staging is up on signed, CVE-clean digests that match `deploy/staging/release-manifest.json`

This document exists so a reviewer can pick the branch up without reading every commit message. It
says what changed, what is measured, what is *not* done, and where to be sceptical.

---

## 1. Verify it yourself before believing any of this

Everything below is reproducible. Nothing here should be taken on the strength of this file — the
repository's own rule is that if a document and the code disagree, the code is right.

**What `verify` needs before it can run**, because four of its sixteen gates fail for want of a
tool rather than a defect and that is a confusing first impression:

| Needed by | What | If it is missing |
| --- | --- | --- |
| everything | Node **24.18.0** and pnpm 11.10.0 (`corepack enable`), then `pnpm install --frozen-lockfile` | — |
| `test`, `db:verify`, `test:a11y`, `test:ax`, `test:keyboard` | PostgreSQL on `DATABASE_URL` — `cp .env.example .env`, set `SESSION_COOKIE_SECRET`, then `pnpm run db:setup` | the database-backed suites SKIP LOUDLY, naming what was skipped; a quiet skip would be a pass. **The summary line will still say `skipped 0`** — Node counts skipped *tests*, and a skipped suite registers none — so read the `﹣` lines, not the counter. Two consequences: `node --test` without `--env-file-if-exists=../../.env` (which the package script passes and a hand-typed `npx tsx --test` does not) silently runs a third of `repositories.test.ts`, and a negative control run that way can "pass" against code it never reached. **`verify` as a whole cannot go green over no SQL**, which is the question that matters and is closed by construction rather than by a guard: `TEST_DATABASE_URL` is derived from `DATABASE_URL` itself, and `apps/api/scripts/verify-schema.mjs` exits 1 when that is unset, so a database-less run fails at `db:verify` and is listed |
| `design:contrast`, `test:ax`, `test:layout`, `test:csp`, `test:age-gate`, `test:keyboard` | Chrome, found automatically or via `CHROME_PATH` | the gate FAILS rather than skipping — these measure a real browser and a pass without one would be worth nothing |
| `security:audit` | Docker, for the container CVE scan; and network access, for OSV and the GitHub Actions advisory corpus | `--offline` skips the network gates and **exits 2** — deliberately not a valid release audit |

The browser gates start their own servers. Ports they take: 3456, 3457, 3458/3459, 3462, 3463,
3464, 3465/3467, and 3000/3001 for the API and web app. A gate that binds a port another process
holds fails for a reason that has nothing to do with what it measures.

```bash
pnpm run verify          # 16 gates, ~50 min. Expect: "=== verify: every gate passed ==="
pnpm run db:verify       # every documented schema security property holds
node scripts/staging.mjs status   # four services healthy, api and web matching the manifest
pnpm run security:containers      # 0 blocking, 0 unfixable, 0 allowed
```

`verify` runs **every** gate even after one fails and exits listing them, so a single run tells you
the whole story rather than the first failure.

**It may take hours rather than the ~50 minutes above, and that is the machine, not the repo.**
`test` runs `--test-concurrency=1` with per-file process isolation, so a large suite is serial by
construction, and the Chrome gates are starved by anything else on the box. If a runner kills it on
a duration cap, run it in batches — the gates are independent, and four batches of four report the
same thing as one run of sixteen. Two things to watch when you do: **`pnpm run verify | tail` reports
`tail`'s exit code, not the gate's**, which is how a run that failed `lint` reached me labelled a
success; and a `nohup ... &` wrapper reports the shell's. Read the log for
`=== verify: every gate passed ===` rather than trusting a number.

---

## 2. What this branch is, in one paragraph

An educational play-money No-Limit Hold'em lab was hardened for a paying cohort. The work was not
feature development: it was finding the places where a guard *looked* like coverage and was green
over nothing, and closing them. The recurring finding — stated here because it is the most useful
thing a reviewer can know — is that **almost every defect was in a guard, not in the product.**

---

## 3. The findings worth knowing about

Ordered by what would have hurt most, not chronologically.

| What | Where it was | How it was found |
| --- | --- | --- |
| **The Coach taught a threshold that does not exist** — "below roughly 20% fold equity the raise and the call are worth about the same". Solving for that frequency gives **−10.2%**; the raise is ahead by 5.7 chips even against an opponent who never folds | `apps/web/src/fixtures/table.ts` | Recomputing every numeric claim the product teaches against the engine |
| **Commitment salts written to logs verbatim** — the redaction denylist named fields the codebase does not have, so `deckSalts` (a `Uint8Array`) was walked as an object and two whole 32-byte salts emitted | `apps/api/src/logging.ts` | Adversarial sweep of hole-card privacy |
| **A HIGH OpenSSL CVE in both shipped images** (CVE-2026-14456, libcrypto3/libssl3 3.5.7-r0) | `Dockerfile.api`, `Dockerfile.web` | The container CVE gate, on a routine `verify` — no human read a feed |
| **The release pipeline ran 5 of 14 gates** — `security:hygiene`, `build`, `design:contrast`, `test:a11y`, `test:ax`, `test:csp`, `test:age-gate`, `test:exhaustive`, `test:simulation` ran in `ci.yml` and nowhere in `release.yml` | `.github/workflows/release.yml` | Reading the two files against each other |
| **A rehearsal could be signed and pushed to GHCR** — a `workflow_dispatch` dry run concludes *success*, and `dry_run: true` is the deliberate safe default | `.github/workflows/release-sign.yml` | Asking what the signing job actually checks about the run that triggered it |
| **A paid place could vanish with no record** — `ON DELETE CASCADE` removes an enrolment, and a referential action writes no audit row, so the trail showed an entitlement that was never closed | `apps/api/src/repositories/users.ts` | Measuring the claim in the migration's own header |
| **The confidentiality check examined zero seats** — it filtered `hand.seats` over a response type with no `seats` field | `scripts/smoke-test.mjs` | Adversarial sweep; this is the *second* time this check has failed this way |
| **Nothing stopped a fourth way to be seated** — `LiveTable.sit` has three call sites and that was prose. An ungated `reseatForRematch` added to the source left 77 tests in the three most relevant suites green | `apps/api/src/rooms/registry.ts` | Testing the claim rather than reading it |
| **The equity bound could not detect a broken evaluator** — `> 0.8 && < 0.84` on a figure whose spread across all 36 configurations is 1.4 points. Making club flushes stop existing moves the average to 82.098%, which that window accepts | `apps/api/test/calc.test.ts` | `docs/VERIFICATION.md` said so itself, in the honest section |
| **Text could collide and no gate could see it** — a collapsed grid track painted a sentence across its own label on the deployed build, with every gate green | `apps/web/src/styles/play.css` | Looking at a screenshot |

Two more that are guards claiming guarantees nobody had written: the audit log's forbidden-key CHECK
was byte-exact and missed `hole_cards`, `cards`, `board`, `reveal` and the four fields the engine
calls the hand's secrets — and the pairing test its comment said kept the two layers in step **did
not exist**. Both closed.

---

## 4. What is now gated that was not

`pnpm run verify` went from fourteen gates to sixteen, and `security:audit` from fourteen to fifteen.
The two counts are unrelated lists that have collided twice; read each off its own list.

- **`test:layout`** — `Range.getClientRects()` over each element's own text nodes, 15 routes × 2
  themes × 5 widths = 150 measurements, 34,098 painted text elements. It measures where the glyphs
  landed, because the defect it was written for does not overlap the element boxes. Six negative
  controls run on every invocation.
- **`test:keyboard`** — existed, was thorough, and ran **nowhere**: it had no `--start`, so it needed
  two servers brought up by hand. Now starts its own and blocks the release. 146 checks, twelve
  consecutive identical runs before it was wired in.
- **`pinned-action-advisories`** — the last unguarded supply-chain surface. Note the trap it avoids:
  OSV's *version-qualified* query returns `{}` for the GitHub Actions ecosystem even for a version
  inside an advisory's range, so a scanner written like `osv-scan.mjs` would have matched nothing for
  ever and printed a green tick.
- **`scripts/release-gate-coverage.mjs`** — reads the `for gate in …` clause of `verify` against both
  workflows' job graphs. Adding a gate is now a three-file change by construction.

---

## 5. Measurements, with the caveats that make them meaningful

| Measurement | Figure | Read this too |
| --- | --- | --- |
| Capacity, worst case | 30 seated players, 7,125 hands/min, p99 14.0 ms, **zero 5xx** | Zero think time — thirty bots racing. CPU 3.69 cores against a 0.9 threshold; the ceiling was **not** found |
| Capacity, human pace | 30 players, CPU **0.12 cores**, Coach p95 179 ms, Review p95 658 ms, zero errors | The worker pool still queues 3 against a threshold of 1. It is the only signal that does not relax |
| Cold start | First Coach analysis 83.6 ms **on the main thread** | That is also the event loop blocked for that long. Once per process; `staging up` warms it |
| Alerting | `alerts:verify` 35 of 35, both tiers, both transports, dead man's switch detected by stopping Alertmanager | Nothing rehearses that a real provider accepts these credentials, or that anybody is awake |
| Recovery | 172.9 MiB archive in 19.9 s; `verify --deep` four layers in 52.6 s, 181 TOC entries incl. **19 ACL entries**, 16 tables compared, scratch DB dropped | Proves the archive decrypts, parses and restores. **Not** that the app works against restored data. No WAL archiving, so RPO is the schedule interval |
| Accessibility | 71 of 72 assertions machine-checked; `test:ax` 117 checks | The one left needs a deliberately broken build |
| Staging smoke | 71 checks over TLS, X-Forwarded-For overwrite confirmed against 24 forged addresses | Says these journeys work on this deployment **once**. Not a load test |

---

## 6. What is NOT done

**Three handoffs, none of them engineering's to close.** `docs/production/go-live.md` §7 carries each.

1. **Counsel.** Eleven entries in `docs/production/legal-review-requirements.md`, each with the facts
   sourced from the code. All are launch blockers. The deletion question narrowed during this work:
   an erasure now writes `enrolment.ended_by_erasure` before the cascade, so the question is no
   longer "can a destroyed entitlement be evidenced" — it can, on both sides — but what the operator
   owes the holder of a live place who erases themselves.
2. **A paging provider.** The path is verified to the edge of a real account: SMTP transactions and
   RFC822 messages are real, delivered to sinks the script runs. `alerts:preflight` refuses
   placeholder, malformed and unrouted destinations. `alerts:ack` needs a person at a TTY.
3. **A git remote.** There is none, so every release is signed with a long-lived key — posture
   **KEY**, which proves possession of a key and *not* the identity of a builder. One tagged push
   makes `release-sign.yml` produce a Fulcio certificate instead.

**Open residuals** are in `docs/VERIFICATION.md` §12, which is the honest section and is worth
reading in full. The two sharpest:

- **A card stringified into a log message** passes every layer — `scrubValue` returns strings
  verbatim, so `log.info({ note: JSON.stringify(state) })` is not caught by a key denylist. Nothing
  does it today.
- **`hidden-information` is a smoke detector on the client, not a control.** `apps/web` refuses a
  frame carrying cards it should not have, but the bytes have already arrived — redaction has one
  boundary, on the server, deliberately.

---

## 7. Where to be sceptical of this work

Reviewing it the way it was written means distrusting green results. Specifically:

- **Three sweeps have already been run for "documentation that lies", so start elsewhere.**
  Markdown links: 324 relative links, **0 broken**. Source-comment file citations: 2,369 backticked
  paths resolved against the citing file, its package root and the workspace roots — **1 wrong**
  (fixed). Comments claiming coverage without naming a test: 67 candidates, all but four inside the
  test that does the asserting; all four source-file claims verified against the test that backs
  them. The one that was unbacked — `audit.ts` promising a pairing test that did not exist — was
  found and closed on 2026-08-27. A fourth sweep looked for tests that cannot fail: **0 skipped, 0
  `.todo`, 0 tautological assertions, and 0 of 3,535 test bodies without an assertion** — the 42
  that a naive scan flags all assert through a local helper (`closeTo`, `assertClose`,
  `rejectsWith`). **The rot was in the review archive, not the code**: see the indexes now in
  `docs/audit/` and `docs/reviews/`.
- **A copied value or condition, left behind by its source, is this branch's most common defect.**
  Four instances, two of them data and two behaviour, all found by asking who else holds a copy:
  `fixtures/legends.ts` carried the AI profiles' trait numbers digit for digit;
  `fixtures/learn-lesson-summaries.ts` carries seventeen lesson titles from `@prl/content`;
  `HandReplay` carried a two-condition abandoned-focus test whose comment claimed it matched
  `ActionBar`, which had since gone to three and then to not sampling at all; and `LiveTable`
  carried the same stale two-condition test, so the rescue its own comment says stops "every
  keyboard reader [being left] on `<body>`" would never have fired. **When you find a value or a
  predicate that exists twice, the question is not whether they agree today — it is what would
  notice when they stop.**
  The signal that separates a dangerous copy from a fine one is **whether the duplication is
  argued**. `ManagedServer` is copy-pasted across six gate scripts and `readStorage`/`writeStorage`
  across `theme.ts` and `SessionDuration.tsx`, each with a comment saying why sharing would be
  worse — those are decisions. All four defects above carried the opposite: a comment asserting the
  copy was in step with an original that had since moved. A scan at a 4-line window over
  `apps/` and `packages/` found 29 cross-file logic duplications and no fifth instance; the rest are
  legal-page markup, which a test already holds together.
- **Fixtures that COPY data are the productive place to look.** Two were found unjoined and are now
  joined: `fixtures/legends.ts` carried the AI profiles' trait numbers digit for digit (110
  byte-identical blocks with `poker-ai/src/profiles.ts`), and `fixtures/learn-lesson-summaries.ts`
  carries all seventeen lesson titles and summaries from `@prl/content`, served from
  `generateMetadata` whenever the API is unreachable. Neither had drifted; nothing was stopping
  them. Of the ten fixtures in `apps/web/src/fixtures/`, eight already had a join and
  `learn-lessons.ts` reformats rather than copies. The question that found both — *what does this
  claim, and what would notice if it stopped being true?* — is worth pointing at anything else that
  restates a value computed elsewhere.
- **Browser measurements in this repo are pinned to Chrome 151, and the gate now runs 152.** There
  are 56 references to "Chrome 151" across tests, components and docs. Recording the version a
  behaviour was measured against is right, and it means those facts have an expiry date — one has
  already expired. `J6.5` went red at a commit whose gate had passed an hour earlier with no code
  change between: `HandReplay`'s focus rescue sampled `document.activeElement` in a React effect,
  and Chrome blurs a control that becomes `disabled` AFTER that effect, so the guard saw the caret
  still on the button and returned early **every time**. The rescue had never once run. It was a
  race the old browser happened to win. Fixed by rescuing the caret-on-a-disabled-control case as
  well, which does not depend on when the blur lands.
  **If a focus or announcement check starts failing without a code change, suspect the browser
  before the branch** — and re-measure rather than loosening the assertion.
- **My checkers were wrong more often than the codebase was.** Across those sweeps I wrote five
  scanners and four had bugs — a resolver missing the package root, a walk that skipped
  `apps/api/test` entirely, `^\s*` matching newlines under `re.M`, and an assert pattern that could
  not see `assert.deepEqual` because it demanded a `(` straight after the word. Every one made the
  code look worse than it is. If you write a scanner here, make it fail loudly on an empty or
  absurd result before you believe a headline number from it — mine each said something alarming
  and each was my error.
- **Every new guard has a negative control**, and each commit message states the measurement. If a
  control is not demonstrated by *running* it, treat the guard as decoration — that is this
  repository's own rule and it caught several of these.
- **`README.md` is joined to nothing, and its numbers drift silently.** Two were wrong when this
  branch was reviewed: its Quick start called `security:audit` eleven gates when it is fifteen
  (stale across four additions), and its soak figure said 50,236 applied actions when the seeded
  soaks produce 50,234. Both fixed. The gate count is now GUARDED —
  `release-gate-coverage.test.mjs` joins that one line to `audit.mjs`'s own array, because it is the
  claim that actually drifted and it drifted four times. The soak figure is not, and neither is
  anything else in the file, so treat every other precise number there as unverified until you
  re-derive it.
- **Counts drift.** `verify` is sixteen and `security:audit` is fifteen; those were both fourteen and
  the equal numbers hid a stale claim for weeks. `readiness-report.test.mjs` now attributes each
  "N gates" claim by its nearest marker, but only for that document.
- **The frozen report.** `docs/production/final-readiness-report.md` is joined to the release
  manifest by a test, and it records superseded measurements *beside* current ones on purpose. Check
  which run a figure comes from before quoting it.
- **Two mistakes were made and corrected during this work** and are recorded rather than tidied
  away: a commit made before reading `biome`'s output, and a `git add -A` that swept a concurrent
  agent's in-flight files into a commit (undone with a soft reset). Both are the same error the
  branch spent its time finding in the codebase — acting on a result that had not actually been read.

---

## 8. Prompts to start the review session

Four prompts, each a session's worth of work, ordered so a bad result in one changes what you do in
the next. Paste one into a fresh session at the repository root. **Prompt 0 is not optional** — it
is the safety brief, and every other prompt assumes it has been given.

Give the reviewer the branch and this file, and nothing else: the point of a second reviewer is that
they are not carrying my conclusions. Sections 3 and 7 above are worth *more* to them after they
have formed their own view than before.

### Prompt 0 — the safety brief (prepend to any of the others)

> This repository has a running staging deployment and real secrets on disk. Constraints, all of
> them hard: never stop, restart, recreate or `exec` into a running staging container without
> telling me first; never run `staging down`, `clean`, `backup restore`, `backup prune --apply` or
> `db:reset`; never modify or drop the live `poker_risk_lab` or staging databases — create a scratch
> database and drop it; never read, print, copy or commit `deploy/signing/cosign.key` or
> `deploy/signing/signing.env`; never send mail to a real address, `.invalid` sinks only; no blanket
> `git stash`, it has swept concurrent work before; do not push, add a git remote, or trigger a
> workflow. Read `CLAUDE.md` first — it is accurate and load-bearing. Run `pnpm run verify` in the
> **background**, never the foreground: it takes ~50 minutes and a foreground shell will be killed
> at its timeout, and run nothing else while it runs, because a concurrent job starves Chrome and
> `design:contrast` fails for that reason and not a real one.

### Prompt 1 — cold start: does the green result survive a stranger?

> Read `docs/HANDOVER.md` §1, then reproduce it from a cold checkout without trusting anything else
> in that file. Get `pnpm run verify` to 16 of 16 yourself and tell me what you had to do that §1
> does not mention — a missing tool, an unstated env var, a port collision, a step that only works
> because of something already on my machine. Then tell me which gates would still have passed if
> the thing they measure were broken. I am more interested in the second answer than the first.

### Prompt 2 — the highest-yield lens: guards that are green over nothing

> This branch's finding was that almost every defect was in a *guard*, not the product: a check that
> looked like coverage and asserted nothing. Examples found and fixed: a confidentiality test that
> examined zero seats, a release pipeline running 5 of its 14 gates, two focus rescues whose early
> return meant they could never once fire.
>
> Do that hunt again, and assume I missed some. For each guard in `scripts/`, `apps/*/test/` and
> `packages/*/test/`, ask the repository's own question: *what would have to break for this to go
> red, and has anyone ever seen it do so?* Prove your answer by breaking the thing on purpose —
> stash the change, watch the guard fail, restore. A guard you cannot make fail is the finding.
> Start with the ones I added on this branch; they are the least weathered. Do not fix anything
> until you have the full list — I want the shape of what I missed, not a patch.

### Prompt 3 — the named defect class, in the places I did not reach

> `docs/HANDOVER.md` §7 names this branch's most common defect: a copied value or condition left
> behind by its source, four instances, three of which carried a comment claiming they were in step
> with an original that had already moved. My sweeps covered `apps/` and `packages/` source at a
> four-line window and fixtures that copy data.
>
> They did **not** cover: SQL in `db/migrations` against the queries in `apps/api/src/repositories`,
> the Prometheus rules in `deploy/staging/observability/alert-rules.yml` against the metric names
> actually registered in `apps/api/src/observability/`, the Compose files against `.env.example`, or
> any constant restated in `docs/` that a test does not join. Hunt there. The test that separates a
> dangerous copy from a fine one is whether the duplication is *argued* in a comment — an unargued
> second copy is the finding, and a comment asserting agreement is a reason to check harder, not
> less.

### Prompt 4 — the review I did not do: the product a student actually meets

> Everything on this branch was infrastructure, guards and release process. What got almost no
> attention is the surface a paying student sees: whether the lessons teach correctly, whether the
> Coach's numbers are right, whether the Lab's explanations match what the engine actually does.
>
> One defect of this kind was found and it was found by reading, not by a gate: the Coach taught a
> break-even threshold of −10.2%, a number that does not exist. Every gate was green.
>
> Know what is already covered before you start, or you will re-run a gate by hand.
> `packages/content/test/taught-figures.test.ts` carries a 28-quote registry that RECOMPUTES every
> numeric claim the teaching prose makes, from `@prl/poker-engine` and `@prl/poker-math`, and
> refuses any entry whose expected value is a literal copied from the content. A second sweep walks
> all 61 live calculations and checks the numbers in a prompt against the inputs the learner is
> actually graded on. `scenario-coherence.test.ts` checks a scenario's narrated bets, all-ins and
> stated stack depths against its own chip counts — that one was written after a scenario titled
> "Nine big blinds" was found giving hero 13.5 of them.
>
> **The gap is what those cannot reach.** A registry only covers what somebody thought to add, and
> the coherence checks are on `scenario.*` fields only. Nothing computes a *definition*, a
> *strategic* claim, or a rule of thumb's unstated preconditions — the classic failure in poker
> teaching being a heuristic that holds heads-up or at one stack depth, presented flatly as
> general. That is the ungated surface. So read `packages/content/data/` and the Lab and Coach as a
> poker player and a teacher rather than as an engineer: check that an explanation of variance is
> correct and not merely fluent, and that a claim stated without qualification deserves to be.

---

## 9. The content audit, and the three things it left open

Four agents read the 5,438 lines of student-facing content against the engine — glossary, quizzes,
the seventeen lessons, and the scenarios plus the Coach and Lab that render them. Every numeric
claim was recomputed rather than eyeballed. The quizzes came back **clean**: all 25 numeric answers
and all 54 `correctIndex` values correct, which is what `taught-figures.test.ts` is for and evidence
that it works.

Everything else found was in the class no gate can compute — a *definition*, a *strategic* claim, a
*label*, or a sentence whose verdict contradicted the number beside it. Nine commits.

The ones worth knowing, because they say where to look next:

- **The Coach told losing hands they had cleared the price.** One template with only its final word
  conditional, so a hero with no equity read "You clear that with 0.0% equity, a -24.3 point
  shortfall". Twelve of thirty-six Lab scenarios. A verdict word appended to a sentence that has
  already delivered the verdict cannot correct it.
- **A panel that could not explain its own verdict.** It showed the chosen EV, the best row and the
  tolerance — three numbers whose only natural reading is a rule the app does not use. Five shipped
  cases where a "consistent" verdict sat beside a best-row gap of up to 132.9 against a tolerance
  of 20.
- **Two producers disagreeing about the same question.** The Lab offered a Raise the Coach refused
  to price; `describeSpr` banded SPR at 1/4/8/15 while `poker-math` used 1/3/6/13, and one panel
  rendered both.
- **A gate reading a stale build.** `regenerate-web-fixtures.mjs` imported `poker-math/dist`, so it
  answered "are the fixtures current?" against whatever the engine was the last time somebody ran
  `tsc` — and printed "already the analysis the engine produces today" over fixtures carrying a
  defect. It reads `src/` now. The same root cause bit again later through a different consumer:
  adding an export to `poker-math` failed 42 `@prl/ui` tests until the package was rebuilt.

**Three were deliberately NOT fixed, and each is a decision rather than a defect:**

1. **`readSituation` feeds every non-hero seat into `opponentStacks`**, so a folded seat contributes
   its full stack — `rk-when-survival-outweighs-chip-ev` reports "at most 7,000 can change hands"
   where the 7,000 belongs to a button its own `facingAction` says folded. A `Scenario` carries one
   `opponentRange` and has no field for who is still in the hand. Fixing it means adding one and
   revisiting 36 scenarios.
2. **SPR has a third convention and a measurement-point mismatch.** `coach.ts`'s teaching notes use
   `<3` shallow / `>10` deep, and `glossary.json` defines SPR as measured "at the start of a street"
   while `buildStackContext` measures after this street's bets — so `rk-low-spr-commit-top-pair`
   shows 0.5 on a page whose own prose says "barely one pot behind" and means 1.26. That one moves
   numbers, not labels.
3. **The Lab and the Coach name the same action differently.** The Lab names it from what hero owes,
   the Coach from the bet level, so a limped pot at the big blind's option is a "bet" on the button
   and a "raise" in the table beside it.

**The unjoined-constant sweep, and its result.** 141 comments across `scripts/`, `apps/` and
`packages/` claim that a value agrees with something in another file. They were checked for the
shape that bites: a literal, a comment asserting agreement, and nothing importing the original.
**One genuine instance**, now fixed — the samples-and-seed pair existed as four literals across
`scenario-analysis.ts`, `routes/content.ts`, `regenerate-web-fixtures.mjs` and
`web-fixture-figures.test.ts`, two of them under comments asserting the agreement, and one of those
two was a guard. `@prl/content` owns the pair now.

The rest came back clean, and *how* they are clean is the useful part, because it is the pattern to
copy:

- **Joined by a test that reads the other file.** `HSTS_EXPECTED` in `staging.mjs` looks like an
  unjoined literal and is not — `staging.test.mjs` parses `deploy/staging/nginx.conf` and asserts
  exactly one `add_header` carrying that value. Four test files read `.env.example` the same way.
- **Argued, and honest about being manual.** `db-wait.mjs` says "if you change one, change the
  other; there is no third place these live", and `reliability-drills.test.mjs` writes its list out
  rather than importing it *so that it cannot shrink in step with the thing it checks* — a
  deliberate anti-join, which is a different thing from an accident.

`config.test.ts` records what this class costs when it does bite: the API's port fallback said 8080
while `.env.example`, `docker-compose.yml`, the README, the runbook and `apps/web/src/lib/api.ts`
all said 3001, so the documented dev flow started the API where the browser was not looking. Found,
fixed, and the incident is in the test.

**Where a reader still beats a gate.** Nothing computes a definition, a strategic claim, or the
preconditions a rule of thumb leaves unstated. Every defect above was found by reading with the
engine open beside the prose, and that is the method to repeat — not another scanner.
