# Working in this repository

Poker Risk Lab is an educational **play-money** No-Limit Hold'em lab: probability, risk/reward, EV
and variance. No real money, ever. Nothing takes payment, and `apps/web/test/legal-pages.test.ts`
trips if that changes, because `/terms` §7 promises a reader the service is free.

This file exists because it did not, and briefs kept pointing at it. Everything below is checkable
against the repo — if a statement here and the code disagree, the code is right and this is a bug.

## The gate

`pnpm run verify` is the release gate: **fourteen** gates, in order —

    security:audit  security:hygiene  lint  build  typecheck  design:contrast  test
    test:a11y  test:ax  test:csp  test:age-gate  test:exhaustive  test:simulation  db:verify

It runs every gate even after one fails, then exits non-zero listing them. `security:audit` is
itself **thirteen** supply-chain gates (`scripts/supply-chain/audit.mjs`) — a different number from
verify's fourteen, and the two get confused.

Gates outside `verify` because they need a deployment: `alerts:verify`, `alerts:preflight`,
`staging`, `backup`, `test:load`, `test:drills`, `release:artifacts`, `release:sign`,
`certify:screen-reader`.

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
