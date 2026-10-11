# Working in this repository

Poker Risk Lab is an educational **play-money** No-Limit Hold'em lab: probability, risk/reward, EV
and variance. No real money, ever. Nothing in it can take money — no processor, no checkout, and no
column that could hold an amount, a currency or a price — and `apps/web/test/legal-pages.test.ts`
trips if that changes, in a dependency, a table name or the source.

`/terms` §7 no longer says the service is free. Since `db/migrations/0006_cohort_enrolments.sql` the
schema records **who holds a place in a course and on whose authority**, and an enrolment record says
nothing about money: a scholarship cohort and a paid one produce identical rows, because the grant
happens out of band. So that test now reads `/terms` to decide which of two postures the page is in
and holds the page and `db/migrations` to the same answer **in both directions** — an enrolment table
with a page that still says "free of charge" fails, and a page describing an enrolment record no
migration creates fails too. Money-table names fail unconditionally in either posture.

This file exists because it did not, and briefs kept pointing at it. Everything below is checkable
against the repo — if a statement here and the code disagree, the code is right and this is a bug.

## The gate

`pnpm run verify` is the release gate: **sixteen** gates, in order —

    security:audit  security:hygiene  lint  build  typecheck  design:contrast  test
    test:a11y  test:ax  test:keyboard  test:layout  test:csp  test:age-gate
    test:exhaustive  test:simulation  db:verify

It runs every gate even after one fails, then exits non-zero listing them. `security:audit` is
itself **fifteen** supply-chain gates (`scripts/supply-chain/audit.mjs`). Those two counts were
equal for a while — worse than being different, because the lists are unrelated and equal numbers
look interchangeable — and `test:layout`, `test:keyboard` and then `pinned-action-advisories` have
since made them sixteen and fifteen. Read each count off its own list anyway; they will collide
again.

The newest of the fifteen is `action-advisories.mjs`, and it exists because **pinning is not
safety**. `ci-pinning.mjs` proves all 60 action references are full commit SHAs, which stops a tag
being repointed — and does nothing at all about a pinned SHA of a version an advisory was later
published against, which stays pinned and stays vulnerable for ever. It resolves each pin to a
version by asking GitHub which tags point at that commit (`git ls-remote --tags`, peeled `^{}` line
and all), **never** by reading the `# v7.0.1` trailing comment: a gate whose answer comes from a
comment is turned green by editing the comment. The comment is instead checked *against* that
answer, so a mislabelled pin fails. Two measurements worth keeping, both against the live services
on 2026-08-27: OSV's version-qualified query returns `{}` for the `GitHub Actions` ecosystem even
for a version squarely inside a published range, so a gate built like `osv-scan.mjs` would have
matched nothing for ever behind a green tick; and OSV's name query is case-sensitive while GitHub's
`uses:` is not, so `azure/setup-kubectl` finds nothing and `Azure/setup-kubectl` finds the advisory.
The gate therefore downloads the whole published corpus and indexes it case-insensitively — which
also lets it refuse a corpus that arrives empty. It went into the `GATES` array in `audit.mjs`, not
into `verify`'s loop, so it touched neither workflow — the three-file rule below is about `verify`.
There is no longer a scheduled run of `security:audit`: `.github/workflows/supply-chain.yml` was
removed on 2026-10-11 at the owner's request. An advisory against a pin nobody has touched is caught
at the next push, or earlier by Dependabot (`.github/dependabot.yml`), which matches advisories on
GitHub's side and opens the upgrade PR.

`scripts/release-gate-coverage.mjs` reads the `for gate in ...` clause of `verify` against the job
graphs of both workflows and fails when they disagree, so **adding a gate is a three-file change by
construction**: `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`.

`pnpm run test:layout` is the newest and the one whose absence cost the most. It measures
**`Range.getClientRects()` over each element's own text nodes** — where the glyphs landed — on
every route, in both themes, at 360/768/1024/1440/1920, and reports four shapes of one failure:
glyphs of two independent in-flow elements overlapping, glyphs painted outside their own box,
glyphs cut off by a non-scrolling ancestor, and a block narrower than its own longest word.

It exists because `.prl-play .prl-coach__section .prl-stat__pair` shipped as
`grid-template-columns: minmax(0, 1fr) auto`. A bare `auto` track is floored at max-content, so a
value that was a sentence took the whole row and the `1fr` label collapsed to nothing with the
sentence painted across it. **Every gate was green** — `design:contrast` composites in real Chrome,
`test:ax` made 111 computed-tree assertions (117 since 6.7 was closed on 2026-08-27), 3,555 unit
tests passed — and it was found by looking at a screenshot. The first probe written for it missed it
too, because it compared the two elements' **bounding boxes**: when a track collapses the boxes do
not overlap, the *text* overflows the box. If you write a layout check, measure the glyphs.

Its negative controls run on every invocation: six stylesheets injected into real pages, one of
them the `minmax(0, 1fr) auto` rule put back verbatim, each of which must be caught. A detector
that stops working fails the gate instead of going quiet.

`pnpm run test:keyboard` is the newest, and it is the only one that was added without writing a
check. It already drove **real keys through Chrome's own input pipeline** — `Input.dispatchKeyEvent`,
not a synthesised `KeyboardEvent`, which does not move focus — over every route: tab order against
the page's own focusable set, focus visibility measured under `:focus-visible` focused against
blurred, no trap, the skip link, the modal sheet's trap and its Escape, the bet-size slider under the
arrow keys, and a whole hand opened, sat down at, dealt and **folded from the keyboard** at a live
socket-backed table. And it **ran nowhere**: `grep -rl 'test:keyboard' .github/workflows/` matched
nothing and `verify` did not list it, for one mechanical reason — it had no `--start`, so
`docs/RUNBOOK.md` told a person to bring up a production build and an API by hand first. A gate that
needs somebody to remember is not a gate. It now starts its own servers (web on **3464**, API on
**3001** — the API port is not a free choice, see the script's header on the frozen `/api/*` rewrite)
and reports 146 checks.

`pnpm run test:ax` runs **three web apps** off one build, and the second and third are fixtures
rather than duplication. 8.2 needs the WEB SERVER's own fetch to fail, so one runs on :3459 with
`PRL_API_ORIGIN` pointing at `127.0.0.1:1` — a port nothing can bind without root. 6.7 needs a deck
proof that does not check out, so one runs on :3465 behind an in-process pass-through proxy on :3467
(`scripts/review-proxy.mjs`) that forwards the real API's real review response with **one hex digit
of one salt flipped**. The edit is a splice into the response *text*, self-checked at exactly one
differing byte, so the fixture authors no payload and cannot go stale against `packages/contracts` —
and the product still contains no code path that can lie about a deal, which is the whole reason
`CommitmentVerifier` exists. A proxy that silently forwarded the bytes unchanged would make the
check pass while proving nothing, so it records every response it corrupted and every one it
refused, and `J6.7` will not score a screen the log does not name.

That row also carries the repository's clearest lesson about a fixture that is *nearly*
deterministic. A reveal proves the board cards that were dealt, so a hand that ends before the flop
has no byte in it to flip — and the first version reused hands played by a hero who folds
immediately, which left "was a board ever dealt" to five bots. **Seven consecutive runs; one failed.**
The fix was not a retry and not a longer timeout: the fixture now plays a hand in which the hero
never folds, which reaches a flop by the rules of the game, and skips boardless hands by reading the
board length off the hand list. Twelve consecutive runs then came back identical, which is the bar
`test:keyboard` was held to and the reason this one is in `verify` rather than beside it.

Gates outside `verify` because they need a deployment: `alerts:verify`, `alerts:preflight`,
`alerts:ack`, `staging`, `backup`, `test:load`, `test:drills`, `release:artifacts`,
`release:sign`, `certify:screen-reader`. `alerts:ack` needs a **person** as well as a deployment — it
sends a real `severity: page` alert through the Alertmanager it is pointed at and fails unless
somebody types back, at a TTY and inside five attempts, a code carried in that page.

`pnpm run alerts:unit` is the exception in that list: it needs Docker but **no deployment**. It runs
`promtool test rules` against `alert-rules.yml` in a throwaway container and asserts on
`ALERTS{alertname=…,alertstate=…}` rather than on annotation prose. It exists because an adversarial
review found alerts that were *mathematically unable to fire* — `rate(x[10m]) > 0` with `for: 10m`
is true for ten minutes minus one scrape interval, so the `for:` can never be satisfied — and every
other check in the repo passed them. **If you change a rule expression, run it.**

**What that pass does not prove, because this file used to claim it did.** It said the code "appears
only in" the delivered notification. That is false and unfixable: the code travels as an alert label,
and Alertmanager's `GET /api/v2/alerts` is unauthenticated and echoes labels back — measured against
a real `prom/alertmanager:v0.28.1`. The caller also chooses `--alertmanager`, so an automated caller
can point it at an Alertmanager it controls, read the code out of its own POST, and type it into a
pty for exit 0. A pass is therefore evidence a **cooperating** operator produces for themselves — one
page, acknowledged at a known time, through the paging path that Alertmanager was configured with —
and not an attestation that survives a caller who wants a green result. The command and the record it
writes both say so; `scripts/alert-ack-page.mjs`'s header has the measurements.

What is sound: the code is never printed by the command on the passing path, the attempts are capped
at five (uncapped, a pty drove ~106,000 guesses/s — a third of a 30-bit space inside `--within 1h`),
and `rehearsal` is decided by reading the targeted Alertmanager's own config over `/api/v2/status`
**and** watching the page arrive at this process's own sinks — never from `PRL_ALERT_*`, which say
what this checkout would render and nothing about where the page went. Unattended mode is fenced on
that measurement. `pnpm run staging up` runs the strict smoke test over TLS against the deployed
images, which is where several guards get their only continuous exercise. `pnpm run staging smoke`
runs it against a stack that is already up, and recreates nothing.

**Do not quote a check count here.** This file said "72 checks"; a run against the live stack on
2026-08-26 reported **71**, and so does `docs/production/final-readiness-report.md`. The total is
emergent — nothing in `scripts/smoke-test.mjs` or its test declares it, and some checks are
conditional on what the run found — so any number written into prose is a number that drifts
without anything noticing. `docs/production/runbooks/public-origin-unreachable.md` still said 72 for
the same reason. Read the count off the run.

## Enrolment

`PRL_ENROLMENT_REQUIRED` is `off` by default and gates exactly one thing when `enforced`: **taking a
seat**. Lessons, the Lab and the glossary stay open — that is the surface a prospective student
browses. The guard lives at a single choke point in `rooms/registry.ts`, not on the routes, because
there are three ways to reach a seat (REST, the WebSocket `sit` frame, a Legends match) and a fourth
would otherwise arrive ungated.

Grants are an **operator CLI** (`pnpm run enrolments`), never an HTTP admin API — there is no admin
role in this system and adding a privilege surface above a learner for a class of thirty buys very
little. `prl_app`, the request-path role, holds **SELECT only** on both enrolment tables: the API can
ask who is entitled and cannot enrol, extend or un-revoke anybody. Writes need
`DATABASE_MIGRATION_URL`.

Enrolment records **who holds a place and on whose authority** — never an amount. A scholarship
cohort and a paid one produce identical rows.

## House style

The style is strongly present in the code; read a neighbouring file before writing a new one.

**Comments say WHY, and name the incident.** Not what the code does — what went wrong, or would.
The best comments here name a measurement: "measured against the running server: 60 consecutive
guest creations produced zero 429s, while freezing the cookie produced a 429 after six".

**Every guard needs a negative control.** A test that fails against the OLD code, demonstrated by
actually running it — stash the change, watch it fail, restore. *A guard whose failure mode has
never been observed is decoration.* Two corollaries that have each caught real bugs here:

- **A sweep of nothing is not a pass.** Every scanner asserts it read a non-empty set. A `readdirSync`
  on a renamed directory, a glob that stopped matching, a constant that became `[]` — all of these
  produce a green check over nothing.
- **A skip must be loud.** `databaseSkip` names what was skipped and why. A quiet skip is a pass.

**Prefer refusing to warning.** Configuration that cannot work should stop the process at boot with
the arithmetic (`config.ts` collects problems and exits 78), not log and continue.

**Fail in the safe direction, and say which direction that is.**

## Things that will bite you

- **Migrations are roll-forward only.** `apps/api/scripts/migrate.mjs` records a sha256 of every
  applied file and aborts on mismatch — editing an applied migration, *including a comment in it*,
  stops migrations on every deployment that has already run it. Add a new file.
- **ADRs are immutable once accepted** (`docs/adr/`). A decision that changes gets a new record that
  supersedes the old one, and the old one is marked.
- **`replicas: 1` is correctness, not sizing.** The live table is in process memory; two API
  processes serving one room deal two different hands. Enforced by a lease since
  `db/migrations/0005`. See ADR 0001 and ADR 0013 — horizontal scale is a protocol change.
- **`biome.json` sets `lineWidth: 110`**, and `lint` fails on formatting. Run `biome check` on the
  files you touched before claiming a gate passes; a reflowed line is the usual way a "docs-only"
  edit breaks the build.
- There are **18 `biome-ignore` comments** in tracked files. Adding one is a last resort — the repo
  has idioms for avoiding them (an explicit `role` instead of relying on an implicit mapping; a
  helper that builds `${` rather than writing it).
- **Tests are `node --test` on native TypeScript**, no framework (ADR 0008).

## Safety

- **Never stop, restart or recreate a running staging container** without saying so first. Never run
  `staging down`, `clean`, `backup restore`, or `backup prune --apply` casually.
- **Never modify or drop the live `poker_risk_lab` or staging databases** as a side effect. Tests
  create a scratch database and drop it. A forward migration on the dev database is normal and fine.
- **Secrets are gitignored and asserted.** `.env`, `deploy/staging/.env.staging`,
  `deploy/backup/backup.env`, TLS keys, `metrics-token`, `deploy/signing/cosign.key` and
  `signing.env`. `scripts/supply-chain/secret-scan.mjs` asserts an ignore rule exists for every path
  the docs tell an operator to create with a secret in it — if you document a new one, add it there.

## Where things are

    docs/adr/                    decisions, immutable, indexed in README.md
    docs/RUNBOOK.md              operating the thing
    docs/production/runbooks/    one file per alert; alerts:verify asserts every rule has one
    docs/production/             readiness, load, security, legal register, accessibility
    scripts/supply-chain/        the audit gates
    packages/                    poker-engine, poker-math, poker-ai, contracts, content, ui
