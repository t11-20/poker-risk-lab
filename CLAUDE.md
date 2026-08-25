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

`pnpm run verify` is the release gate: **fourteen** gates, in order —

    security:audit  security:hygiene  lint  build  typecheck  design:contrast  test
    test:a11y  test:ax  test:csp  test:age-gate  test:exhaustive  test:simulation  db:verify

It runs every gate even after one fails, then exits non-zero listing them. `security:audit` is
itself **fourteen** supply-chain gates (`scripts/supply-chain/audit.mjs`) — the same number as
verify's fourteen since the keyless-signing identity gate was added, which is worse than a different
number: the two lists are unrelated and now look interchangeable. Read each count off its own list.

Gates outside `verify` because they need a deployment: `alerts:verify`, `alerts:preflight`,
`alerts:ack`, `staging`, `backup`, `test:load`, `test:drills`, `release:artifacts`,
`release:sign`, `certify:screen-reader`. `alerts:ack` needs a **person** as well as a deployment —
it sends a real page and fails unless somebody types back a code that appears only in it. `pnpm run staging up` runs the strict smoke test — **72 checks** over TLS
against the deployed images, which is where several guards get their only continuous exercise.

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
