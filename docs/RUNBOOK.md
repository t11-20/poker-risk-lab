# Runbook

Everything you need to run, verify, and operate Poker Risk Lab.

---

## 1. Prerequisites

| Tool | Version | Why pinned |
| --- | --- | --- |
| Node | **24.18.0** | `engineStrict` refuses anything else; the test runner relies on Node 24's native TypeScript execution |
| pnpm | **11.10.0** | Pinned with an integrity hash in `packageManager`, verified by Corepack |
| Docker | any recent | PostgreSQL 16 for local development |

```bash
corepack enable            # uses the packageManager field, so the hash is checked
node --version             # must be v24.18.0
pnpm --version             # must be 11.10.0
```

## 2. First run

```bash
cd poker-risk-lab

pnpm install --frozen-lockfile     # never --no-frozen-lockfile
pnpm run security:audit            # 9 gates; must pass before anything else

cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
# paste that into SESSION_COOKIE_SECRET in .env

pnpm run db:setup                  # up + wait + migrate + seed
pnpm run build:packages
pnpm run dev                       # api on :3001, web on :3000
```

Open <http://localhost:3000>. No sign-in is needed — the app is guest-first.

### Use `localhost`, not `127.0.0.1`

They are the same machine and **different origins**, and three separate mechanisms in this stack
care about the difference:

* **The browser's cookie jar.** The session and CSRF cookies are host-scoped (`__Host-` prefixed
  in production, no `Domain`), so a cookie set on `localhost` is never sent to `127.0.0.1`.
  Switching host mid-session presents as being silently signed out.
* **The API's `PUBLIC_WEB_ORIGIN` allowlist**, which is matched exactly. `.env.example` ships
  `http://localhost:3000`. Loading the app from `127.0.0.1:3000` with that value gives refused
  CORS requests and WebSocket closes with 4406, with no message naming the cause. If you want both
  to work, list both: `PUBLIC_WEB_ORIGIN=http://localhost:3000,http://127.0.0.1:3000`.
* **Next's dev-asset origin check.** This one used to be a trap: `next dev` served the HTML from
  `127.0.0.1` and returned **403 for every `/_next/*` chunk**, so the page rendered and then never
  hydrated — no error, nothing responding to a click. `allowedDevOrigins` in
  `apps/web/next.config.ts` now lists both hosts, so this specific failure is gone. Unknown
  origins are still refused.

The repository is not yet consistent about which one it prints: `scripts/dev.mjs` and
`scripts/a11y-audit.mjs` use `127.0.0.1:3000`, `scripts/smoke-test.mjs` uses `localhost:3000` for
the web and `127.0.0.1:3001` for the API. All of them work now, but **pick one for your browser
and stay on it** — the cookie jar is the mechanism that will not forgive switching.

The container stack has no such split: there is exactly one published origin (§6).

## 3. Command reference

### Development

| Command | What it does |
| --- | --- |
| `pnpm run dev` | API and web dev servers together, output prefixed per process |
| `pnpm run dev:api` | API only |
| `pnpm run dev:web` | Web only |
| `pnpm run build` | Build packages, then apps |
| `pnpm run build:packages` | Packages only — **required before running tests** |
| `pnpm run clean` | Remove `dist/`, `.next/`, `*.tsbuildinfo`, `coverage/` |

### Quality

| Command | What it does |
| --- | --- |
| `pnpm run lint` | Biome check across the repo |
| `pnpm run lint:fix` | Biome check with safe fixes applied |
| `pnpm run format` | Biome format |
| `pnpm run typecheck` | `tsc --noEmit` in every package |

### Tests

| Command | What it does | Runtime |
| --- | --- | --- |
| `pnpm run test` | **Builds the packages**, then unit + integration + script tests. **Needs a database** | ~2–3 min |
| `pnpm run test:unit` | Package and web tests only | ~1 min |
| `pnpm run test:integration` | API tests | seconds |
| `pnpm run test:scripts` | The `scripts/*.mjs` tooling's own tests | seconds |
| `pnpm run test:no-database` | Builds, then the whole suite with the database waiver applied — see below | ~2 min |
| `pnpm run test:exhaustive` | **All 133,784,560 seven-card hands** against published frequencies | ~7 s |
| `pnpm run test:simulation` | AI-Legends declared traits against a large simulation | ~2 min |
| `pnpm run test:a11y` | Static accessibility audit of the rendered pages. Starts web on **:3000** itself, or pass `--no-start --base-url <url>` | ~30 s |
| `pnpm run test:smoke` | End-to-end smoke against a running stack; `-- --strict` fails on warnings | seconds |
| `pnpm run test:load` | WebSocket load harness against a local server | configurable |
| `pnpm run test:all` | test + exhaustive + simulation + a11y | ~5 min |
| `pnpm run fixtures:check` | Report drift between `apps/web/src/fixtures/**` and what the engine computes today. Changes nothing | seconds |
| `pnpm run fixtures:regenerate` | Rewrite those fixtures from the engine. **The remedy for a failing fixture guard** | seconds |

**Never hand-edit a number in `apps/web/src/fixtures/**`.** Those files are what the web
client renders when the API is unreachable, and every figure in them — equity, out counts,
prices, expected values — is *computed*. `apps/api/test/web-fixture-figures.test.ts`
recomputes each one and fails on a mismatch, so the drift is caught by `test` and therefore
by `verify`.

That guard's failure message has always been "regenerate the fixture rather than editing the
number", and **until 2026-08-18 the repository contained nothing that could do so.** The
result is the reason these two commands are worth a paragraph: the engine was corrected, the
fixture was not, and the Scenario Lab shipped a rule-of-2-and-4 estimate of `1.6` that the
panel rendered to a learner as **"160.0%"** — a probability above 100% in an application
whose subject is probability. A guard whose remedy is not executable is a guard that gets
left red. `scripts/regenerate-web-fixtures.mjs` is now that remedy, and it deliberately
duplicates the guard's computation rather than importing it, so agreement between them is
evidence rather than a shared bug. Verified 2026-08-19: `pnpm run fixtures:check` →
`web fixtures are already the analysis the engine produces today`, exit 0.

Runtimes are estimates on one developer machine. Two were re-measured on 2026-08-18 and the table
now says what was measured rather than what was hoped: `test:exhaustive` **6.8 s** (133,784,560
hands at 20.8 M/s) and `test:simulation` **1 min 58 s**, which the table used to give as ~30 s. The
rest are unchanged estimates plus the build step, and are not measurements.

**`test` builds the packages first, and that is not a convenience.** Every `@prl/*` package resolves
its `.` export to `dist/`, and `dist/` is `.gitignore`d — so a fresh checkout could not run the suite
at all, and a checkout with a stale `dist/` ran the suite against *the previous build of the code*
while reporting green. Testing a stale artefact that is not part of the audited source is a worse
failure than a missing one, because it is silent. The build is incremental, so on a warm tree it
costs seconds.

**The database tests cannot be skipped silently.** With no database reachable, `pnpm run test`
exits 1 and tells you to run `pnpm run db:setup`. The only waiver is the named script
`pnpm run test:no-database`, which prints a banner saying the run proves nothing about SQL — and
that waiver is **refused whenever `CI` is set**, so no CI provider can ever take it.

This rule exists because the alternative was worse than a red build: 56 database tests used to
skip silently while the suite exited 0, and six of them are the ones asserting that a player can
never receive another player's hole cards. A guardrail that skips is not a guardrail.

### Security

| Command | What it does |
| --- | --- |
| `pnpm run security:audit` | **All nine supply-chain gates.** Itself one of the eleven gates inside `pnpm run verify`, which is the release gate as a whole |
| `pnpm run security:audit -- --offline` | Skips the two network gates and **exits 2** — *not* a valid release audit |
| `pnpm run security:policy` | Is the supply-chain policy actually in effect? |
| `pnpm run security:hygiene` | Source encoding, NUL bytes, hidden/bidi characters |
| `pnpm run security:denylist` | Banned packages anywhere in the graph |
| `pnpm run security:shapes` | Resolution shapes, install scripts, exact versions |
| `pnpm run security:ioc` | Shai-Hulud IOC sweep of the tree and the installed store |
| `pnpm run security:pinning` | CI actions pinned by commit SHA, base images by digest, no undeclared workflow |
| `pnpm run security:provenance` | Lockfile ↔ registry integrity, release-age cooldown |
| `pnpm run security:osv` | OSV.dev vulnerability scan |
| `pnpm run security:sbom` | Generate the CycloneDX 1.6 SBOM |
| `pnpm run deps:quarantine` | Resolve dependencies in a scrubbed, secret-free quarantine |

**`--offline` exits 2 and that is the point.** It prints `2 network gate(s) skipped — NOT a
valid release audit` and exits non-zero, so a pipeline reading only the exit code cannot
mistake a partial audit for a passing one. Exit **2**, not 1, so a caller can still
distinguish "gates were skipped" from "a gate failed". It used to exit 0 with two gates
unrun, which is exactly the failure this project keeps finding: a check that cannot fail.

### Database

| Command | What it does |
| --- | --- |
| `pnpm run db:up` | Start PostgreSQL |
| `pnpm run db:wait` | Block until it accepts connections |
| `pnpm run db:migrate` | Apply pending migrations |
| `pnpm run db:migrate:status` | Show applied and pending. Reads `DATABASE_MIGRATION_URL`, so it needs a migration identity — see the note below |
| `pnpm run db:roles` | Create the cluster-wide `prl_migrator`/`prl_app` roles. Only needed before a **restore** (§11.4); `db:migrate` creates them otherwise |
| `pnpm run db:seed` | Apply dev seeds, **including the `prl_api`/`prl_deployer` login roles** (**refuses under `NODE_ENV=production`**) |
| `pnpm run db:reset` | Drop and recreate the schema (**refuses under `NODE_ENV=production`**). Leaves the cluster-wide roles alone |
| `pnpm run db:setup` | up → wait → migrate → seed |
| `pnpm run db:verify` | Assert the **live** schema's security properties (§5) |
| `pnpm run db:down` | Stop PostgreSQL |

**Two connection strings, and they are not interchangeable.** `DATABASE_URL` names `prl_api`
— the runtime identity, DML only. `DATABASE_MIGRATION_URL` names the migrating identity
(`poker` locally, `prl_deployer` in a deployment), and `apps/api/scripts/*.mjs` read it in
preference to `DATABASE_URL`. Point `DATABASE_MIGRATION_URL` at `prl_api` and
`db:migrate:status` answers `permission denied for table schema_migrations` — measured
2026-08-19 — because the ledger is deliberately not readable by the runtime role. That is the
privilege boundary working, not a broken command.

### The one command before a release

```bash
pnpm run verify
# security:audit · security:hygiene · lint · build · typecheck · design:contrast
# test · test:a11y · test:exhaustive · test:simulation · db:verify
```

**Every gate runs, every gate reports, and the command exits non-zero if any of them failed.** It
prints `=== PASS <gate> ===` or `=== FAIL <gate> ===` after each one and finishes with the list of
gates that did not pass.

That is not a style choice. `verify` used to be a `&&` chain ending in `db:verify`, which meant a
failure anywhere skipped everything after it — and because `test` was failing, **the gate this
runbook describes as asserting the live schema's security properties had never once executed inside
the command operators are told to run.** It passed when run on its own, which is exactly why nobody
noticed. A chain reports the first failure; a release gate has to report all of them, because the
question before a release is "what is wrong", not "what is the first wrong thing".

`build` still runs **before** `typecheck` and before `test`, and the order is load-bearing rather
than stylistic: every `@prl/*` package resolves its types through its built `dist/`, so a typecheck
on a clean tree with no `dist/` reports missing modules that a build would have produced. Keep it.
A failing `build` will therefore also fail `typecheck` and `test` — that is a cascade, not a skip,
and every one of them is still reported.

Three gates were added because a claim no gate enforces is a claim, not a result: `test:a11y`
(accessibility is a stated functional requirement, and it was in no gate at all), `test:exhaustive`
(the strongest single check in the project, and 7 seconds) and `test:simulation` (the AI profiles'
only statistical evidence, ~2 minutes — which is what a release gate is for).

## 4. Adding a dependency

This is a **reviewed event**, not a routine one. Read `docs/SECURITY.md` §2 first.

```bash
# 1. Re-take the advisory snapshot. Do not skip this.
#    Write a new dated file under docs/security/ — never edit the existing one.

# 2. Resolve in quarantine: throwaway HOME, scrubbed env, no source, no .env, no .git
pnpm run deps:quarantine

# 3. Review every added line
git diff -- pnpm-lock.yaml

# 4. Install and audit
pnpm install --frozen-lockfile
pnpm run security:audit
```

Expect friction. The newest patch is often **not installable** because of the 7-day
release-age cooldown — pin an older one. A dependency declaring an install script needs
human approval and an ADR; there is no bypass flag.

## 5. Migrations

Migrations are **checksummed**. Editing an already-applied migration makes `db:migrate`
abort rather than silently reapply, because a quietly-edited migration is a production
incident waiting to happen.

To change the schema: add a new numbered file. Never edit an applied one.

The runner takes a PostgreSQL advisory lock, so two concurrent deploys cannot both migrate.

**There is no `down`, and that is a policy rather than a missing feature.** `migrate.mjs down`
is a first-class command that refuses and explains; `up` refuses a pending migration containing
a destructive or renaming statement unless the file declares itself irreversible. The policy,
the four alternatives to a rollback, and the `-- prl:irreversible:` marker are in **§11.3**.

### The two roles, and the step that is easy to miss

`prl_migrator` owns the schema; `prl_app` is the runtime role with DML only — no `CREATE`,
`DROP`, `TRUNCATE`, and no ownership.

**Neither of them can log in.** `db/migrations/0001_initial.sql` creates both `NOLOGIN` with no
password, on purpose: they are privilege containers, not identities. Nothing connects *as*
`prl_app`; something connects as a login role that is a **member of** `prl_app` and inherits its
privileges. Putting a password on a role that appears in a migration would put a credential in
version control, which is why the migration does not do it.

So a real deployment has one more step, and it is the step whose absence looks like a broken
runbook:

```sql
-- Run once per environment, as a superuser, with a password from your secret manager.
-- Two identities, because the two jobs have different blast radii and want different rotation.
CREATE ROLE prl_api      LOGIN PASSWORD :'api_password';
CREATE ROLE prl_deployer LOGIN PASSWORD :'deployer_password';

GRANT prl_app      TO prl_api;       -- the serving process: DML only
GRANT prl_migrator TO prl_deployer;  -- the migration job: owns the schema

-- Confirm. rolcanlogin must be true for the two new roles and false for the two granted ones.
SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname LIKE 'prl%';
```

Then `DATABASE_URL` for the API names `prl_api`, and the migration job names `prl_deployer`.
Least privilege is unchanged by this: the login roles hold no privileges of their own, only what
membership grants, so revoking access is `REVOKE prl_app FROM prl_api` and nothing else.

Verify the privileges are actually the ones documented with `pnpm run db:verify`.

### Development rehearses this, as of 2026-08-18

> **This paragraph used to say the opposite, and the opposite was the defect.** It read: "the
> local stack connects as the dev superuser `poker`, so the least-privilege path is not exercised
> in development." That was true, and it meant every local query ran with `rolsuper` and
> `rolbypassrls` — so a statement needing a `GRANT` that `prl_app` does not hold could not fail
> until production, which is the first place it *would* fail.

`db/seeds/0002_dev_login_roles.sql`, applied by `pnpm run db:seed` (and therefore by
`pnpm run db:setup`), creates the same two login roles the SQL above creates by hand — `prl_api`
and `prl_deployer` — with the throwaway password `poker-dev-only`, and grants them membership in
`prl_app` and `prl_migrator`. The names match on purpose: development should rehearse the
deployment's shape, not a parallel one. A seed can do this at all only because `seed` **refuses
to run under `NODE_ENV=production`** — a password in version control must not be able to reach a
deployment.

Both `docker-compose.yml` and `.env.example` now point `DATABASE_URL` at **`prl_api`**, so the
development API, the test suite and `pnpm run db:verify` all run against exactly the privileges
the deployment gives them. Migrations and seeds use `DATABASE_MIGRATION_URL` instead, which is
the cluster owner locally and `prl_deployer` in a deployment.

The seed ends with a check rather than a comment: if `prl_api` cannot reach schema `prl` through
its membership, or if it somehow holds `CREATE` on it, the seed raises instead of leaving a
developer to meet the problem as a permission error at request time.

> **The failure a developer who skipped `db:seed` will actually see** is
> `password authentication failed for user "prl_api"` — from `psql`, from the API at boot, and
> from `pnpm run db:verify` (measured 2026-08-19). PostgreSQL answers 28P01 for a role that does
> not exist as well as for a wrong password, deliberately, so that the message cannot be used to
> enumerate roles — which means it does **not** tell you the role is missing.
>
> The fix is **`pnpm run db:seed`**, not a superuser in `DATABASE_URL`. Editing `DATABASE_URL`
> back to `poker` makes the symptom disappear and quietly restores the defect above.

## 6. Containers

```bash
docker compose up -d postgres
pnpm run db:migrate && pnpm run db:seed

# SESSION_COOKIE_SECRET has no default. Compose refuses to start without it.
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
# paste into SESSION_COOKIE_SECRET in .env

docker compose up -d --build
```

Then open <http://localhost:3000> — the same URL as `pnpm run dev`, deliberately.

### Four services, one published origin

```
browser ──▶ 127.0.0.1:3000 ──▶ proxy ──┬─▶ /api/*, /ws*  ──▶ api:3001 ──▶ postgres:5432
                                       └─▶ anything else ──▶ web:3000
```

`proxy` (nginx-unprivileged, digest-pinned, config inline in `docker-compose.yml`) is the only thing the
browser talks to. That is not tidiness — it is what makes the `__Host-` session cookie work, and
it is why the web client can use relative `/api/...` paths and carry no API address in its
JavaScript bundle. `/api/*` is every REST route **and** the WebSocket upgrade at `/api/v1/ws`.

`web` publishes no port. `api` publishes `127.0.0.1:3001` for `curl` and host-side scripts only —
it is not the browser's path to the API and nothing should treat it as one.

| Variable | Default | Effect |
| --- | --- | --- |
| `WEB_PORT` | `3000` | Host port for the proxy — **the** app URL |
| `API_PORT` | `3001` | Host port for the API, loopback, tooling only |
| `POSTGRES_PORT` | `5432` | Host port for PostgreSQL, loopback |
| `PRL_PROXY_API_UPSTREAM` | `api:3001` | Where the proxy sends `/api/*`. Read at container start |
| `PRL_PROXY_WEB_UPSTREAM` | `web:3000` | Where the proxy sends everything else |
| `SESSION_COOKIE_SECRET` | *none* | **Required.** Compose stops and names it if unset |

All three images run as a non-root user (uid 1000) with a read-only root filesystem, `cap_drop:
ALL`, `no-new-privileges`, an explicit tmpfs for each path that legitimately needs writing, and a
`HEALTHCHECK` that probes the container's own network address rather than `127.0.0.1` — so a
server bound to loopback reports **unhealthy** instead of reporting healthy and being unreachable.
`init: true` is set for correct signal handling. Every base image is pinned by `@sha256:` digest,
and since 2026-08-19 that is enforced rather than asserted: `pnpm run security:pinning` fails the
release on an unpinned `FROM` or `image:`, the same way the npm policy fails an unpinned package.

### Rebuilding is not how you retarget the API

`PRL_PROXY_API_UPSTREAM` changes where `/api/*` goes, at container start, with no rebuild:

```bash
docker compose up -d proxy                                  # normal
PRL_PROXY_API_UPSTREAM=other-api:3001 docker compose up -d proxy
```

The one genuinely build-time setting is `PRL_API_REWRITE_ORIGIN` (`--build-arg`, Dockerfile.web),
which only matters for a bare `docker run` of the web image with no proxy in front. Set it in a
running container's environment and the web app **refuses to start** and tells you why, because
that variable — like the `NEXT_PUBLIC_API_ORIGIN` it replaced — is inlined by `next build` and
would otherwise be silently ignored.

### The local stack is a development stack

`api` runs with `NODE_ENV=development` here. The production profile refuses a plaintext `http://`
origin and refuses `COOKIE_SECURE=false`, both correctly — a `Secure` cookie is never sent over
plain HTTP, so sign-in could not work — and this stack is plain HTTP on loopback. Nothing in
`apps/api/src/config.ts` was relaxed to make that true: set `NODE_ENV=production` here and you get
the refusal, verbatim, listing every problem at once. §11 has the production profile.

## 7. Configuration

Full list with descriptions in `.env.example`. The ones that matter:

| Variable | Read by | Notes |
| --- | --- | --- |
| `SESSION_COOKIE_SECRET` | api | ≥ 32 bytes. The server **refuses to boot in production** with a short, default or example value, and `docker-compose.yml` refuses to start without it at all. |
| `PUBLIC_WEB_ORIGIN` | api | Comma-separated allowlist of the origin **the browser uses** — behind a proxy that is the proxy's public origin, not the app's internal one. Used for CORS **and** the WebSocket `Origin` check. Getting this wrong is how cross-site WebSocket hijacking happens. No trailing slash, no path, no wildcard: all four are rejected at boot. |
| `HOST` | api | Bind address. Defaults to `127.0.0.1`, which is right on a laptop and wrong in a container. Both images set `0.0.0.0` themselves; do not override it back without reading the comment in `Dockerfile.api`. |
| `DATABASE_URL` | api, scripts | Connect as a login role that is a **member of** `prl_app` — `prl_app` itself is `NOLOGIN`. See §5. |
| `PRL_API_ORIGIN` | web (server) | Where the web app's **server-side renders** fetch the API, e.g. `http://api:3001`. Runtime, read on every boot, never inlined. The browser does not use it: it calls its own origin and the proxy routes `/api/*`. |
| `PRL_PROXY_API_UPSTREAM` / `PRL_PROXY_WEB_UPSTREAM` | proxy | The proxy's two upstreams, read when it parses its config at start. |
| `OIDC_*` | api | All-or-nothing. Any one present means all must be present. Omit entirely to run guest-only. `OIDC_REDIRECT_URI` must name the API's own origin and port. |
| `MONTE_CARLO_MAX_SAMPLES` | api | Server-side ceiling. The schema also caps the request. |
| `TRUST_PROXY` | api | Only enable when the API is reachable **exclusively** through a proxy you control — it makes `X-Forwarded-For` trusted, and therefore spoofable by anyone who can reach the API directly. The local stack leaves it off because it publishes the API port for tooling. |

Build-time only, and they will not work at runtime:

| Variable | Where | Notes |
| --- | --- | --- |
| `PRL_API_REWRITE_ORIGIN` | `docker build --build-arg` | The `/api/*` rewrite destination baked into the web bundle for a proxy-less `docker run`. Setting it on a running container makes the web app refuse to start. |
| `NEXT_PUBLIC_API_ORIGIN` | *gone* | The old design. No longer read anywhere; setting it on a running container makes the web app refuse to start, because it used to be silently ignored. |

Configuration is validated **once at startup**, reporting every problem at once. The server
refuses to boot rather than run half-configured.

## 8. Verifying a hand yourself

Every completed hand publishes a Merkle root before the deal and proofs afterwards. To
check a deal was not altered:

```
GET /api/v1/hands/:handId
```

The response carries `commitmentRoot`, `commitmentContext` and `reveal`. Feed the reveal to
`verifyDeckReveal()` from `@prl/poker-engine` — the same function the web app runs, so you
are not taking the server's word for it.

**Expect a fold-out hand to reveal nothing.** That is correct, not broken: no board was
dealt and nobody showed, so there is nothing that may legitimately be revealed. See
ADR 0004 for why revealing more would be a serious leak.

## 9. Troubleshooting

**`pnpm install` refuses a version.** The release-age cooldown (7 days). Pin an older
patch. Do not add it to `minimumReleaseAgeExclude` — the policy gate fails if that list is
non-empty.

**`security:policy` fails.** A policy key is in `.npmrc`, where pnpm 11 ignores it. Move it
to `pnpm-workspace.yaml`.

**`security:hygiene` fails with "control character".** A literal ESC or NUL byte reached a
source file. Replace it with an escape sequence (`\x1b`). This gate exists because it
happened during development: a stray NUL inside a template literal was invisible in every
editor and in `git diff`, and silently changed a map key separator.

**Tests fail with "Cannot find module '@prl/poker-engine'".** Run
`pnpm run build:packages`. Packages resolve through their built `dist/`. `pnpm run test` does
this for you now; a bare `node --test` in one package does not.

**`password authentication failed for user "prl_api"`.** The development login roles have not
been created. Run **`pnpm run db:seed`**. PostgreSQL returns 28P01 for a role that does not
exist as well as for a wrong password — deliberately, so the message cannot be used to enumerate
roles — so it does not say "no such role". Do **not** repair this by putting the superuser back
in `DATABASE_URL`: that is the defect §5 describes, and it hides missing `GRANT`s until
production.

**`permission denied for table schema_migrations`.** Something migration-shaped is connecting as
`prl_api`. `apps/api/scripts/*.mjs` read `DATABASE_MIGRATION_URL` in preference to
`DATABASE_URL`; set it to the cluster owner locally, or `prl_deployer` in a deployment (§5). The
runtime role not being able to read the ledger is the privilege boundary working.

**`pending migration(s) destroy something and do not say so`.** `up` refuses a destructive or
renaming statement in a pending file. Make the change additive and ship the removal in a later
release, or declare it: `-- prl:irreversible: <what is lost, and why a restore is the only way
back>`. §11.3.

**`web-fixture-figures` fails.** A computed figure in `apps/web/src/fixtures/**` no longer matches
what the engine produces. The fix is `pnpm run fixtures:regenerate`, never editing the number.
`pnpm run fixtures:check` shows the drift first without writing anything.

**`verifyDepsBeforeRun` error.** `node_modules` no longer matches the lockfile. Run
`pnpm install --frozen-lockfile`.

**The API refuses to boot.** Read the message — config validation lists every problem at
once. The usual cause is a missing or too-short `SESSION_COOKIE_SECRET`.

**`docker compose up` stops with "required variable SESSION_COOKIE_SECRET is missing".** Working
as intended: there is no default. §6, step two.

**A container is `healthy` but nothing can reach it.** It cannot be, any more — the healthchecks
probe the container's own network address, not `127.0.0.1`, precisely so that a server bound to
loopback fails its probe. If a container is *unhealthy* and its log shows a clean start, check
`HOST` (api) or `HOSTNAME` (web): something has overridden the `0.0.0.0` the images set.

**The web container exits with "Refusing to start: 1 build-time-only variable(s)".** You set
`PRL_API_REWRITE_ORIGIN` or `NEXT_PUBLIC_API_ORIGIN` on a running container. Both are inlined at
build time and would have been ignored. Route `/api/*` at the proxy instead (§6), or rebuild with
`--build-arg`.

**Every API call from the browser 404s in the container stack.** The page was loaded from
something other than the proxy — a `ports:` entry added to `web`, or a direct container address.
Relative `/api/...` only resolves on the proxy's origin. Use `http://localhost:${WEB_PORT}`.

**The API container dies at boot with `ERR_MODULE_NOT_FOUND` on a `@prl/*` dist.** A workspace
package's build output is missing from the image. Both Dockerfiles copy `/app/packages` as one
directory for exactly this reason, so the likely cause is a build that partly failed — check the
`build` stage output rather than adding a `COPY` line.

**WebSocket closes immediately with code 4406.** The `Origin` header did not match
`PUBLIC_WEB_ORIGIN`. This is the cross-site WebSocket hijacking guard working.

**WebSocket closes with 4400.** Client and server protocol versions disagree. Hard-reload
the page.

**`stale_action_sequence` in the UI.** Not a bug: the hand advanced while the player was
deciding, so the action was rejected rather than applied to a spot they never saw.

## 10. Operational notes

* **Logs** are structured JSON with a request id per line. Cookies, tokens, invite codes,
  OIDC codes and display names are redacted. IPs are logged as keyed hashes.
* **Health**: `GET /api/v1/health` (liveness), `GET /api/v1/ready` (readiness, checks the
  database).
* **Graceful shutdown** on SIGTERM/SIGINT: stop accepting, close every WebSocket with a real close
  frame, drain in-flight work, close the database pool and the equity worker pool, exit 0. It exits
  non-zero only if the drain genuinely fails or the grace period (`SHUTDOWN_GRACE_MS`, default 10 s)
  expires first.

  Three details an operator plans around.

  **A keep-alive socket does not hold the drain open.** Fastify's `forceCloseConnections: 'idle'`
  only drops sockets that are idle at the instant SIGTERM arrives; a socket that was mid-request is
  not, and Node would then hold it for the full `keepAliveTimeout` (72 s) — far past any deploy
  grace. So the shutdown path collapses `keepAliveTimeout` and sweeps for newly-idle sockets until
  the drain finishes.

  **An open WebSocket does not hold it open either, and it is told why it is closing.** The hub's
  `preClose` hook (`apps/api/src/ws/hub.ts`) sends every live socket a close frame carrying
  `WS_CLOSE.serverShuttingDown` (**4503**) and then drops any peer that has not answered the
  handshake within a tenth of `SHUTDOWN_GRACE_MS`. The code matters as much as the exit code: a
  client cannot tell a deploy from a lost network unless the server says so, and the web client has
  a "the server is restarting" state keyed on exactly that value. This is closed in `preClose` and
  not `onClose` because Fastify's order is `preClose` → `server.close()` → `onClose`, and
  `server.close()` waits for every upgraded connection — an `onClose` that closed them would be
  waiting for the thing waiting for it.

  **The worker threads are closed on the shutdown path itself**, not only through a route module's
  `onClose` hook, because four live worker threads at exit present as a deploy that simply hangs.

  Set the orchestrator's termination grace period above `SHUTDOWN_GRACE_MS`, not below it, and not
  equal to it — `docker-compose.yml` now sets `stop_grace_period: 30s` against `SHUTDOWN_GRACE_MS:
  '10000'` and says so next to both. A tie is not a margin: the two timers start together, so
  whichever the scheduler reaches first ends the process, and the app's own "why" log line is lost
  with it. Do not add retries or a longer grace to compensate for an exit 1: fix the drain, because
  an exit 1 means the process could not finish, and slowing every rollout down does not change that.

  > **This paragraph used to be wrong, which is why it now cites its evidence.** Until the
  > 2026-08-18 fix, `ws` was registered with `clientTracking: false`, which made
  > `@fastify/websocket`'s `defaultPreClose` a silent no-op (`if (server.clients)` is `undefined`).
  > Every upgraded socket stayed open, `app.close()` never resolved, and the grace deadline fired
  > `process.exit(1)`. The release audit measured it with **one idle WebSocket and no load**:
  > 10.18 s and exit 1 on the host, and exit 137 (SIGKILL) under `docker compose stop`
  > (`docs/audit/final-release-audit.md` P0-3) — while this runbook called the behaviour "a defect
  > and is fixed". It was not; the suite that was supposed to prove it passed 3/3 and contained no
  > WebSocket at all.
  >
  > What is written above is what `apps/api/test/shutdown.test.ts` now asserts, over a real spawned
  > server and real sockets, and it was re-run for this paragraph rather than taken on trust:
  > **5/5 pass** — a socket at a table, a socket that has not finished its handshake, a client that
  > ignores the close frame entirely, a keep-alive request in flight, and a worker-thread
  > calculation in flight. The suite also asserts the drain finishes inside a *third* of the grace,
  > so "inside the deadline" cannot pass for "prompt".
* **Scheduled audit**: `.github/workflows/supply-chain.yml` runs the full audit daily
  against the committed lockfile, so an advisory disclosed against an already-pinned
  dependency surfaces without waiting for a push.

## 11. Deploying it

`docker-compose.yml` is a developer's machine — its own header says so. This section is the set of
constraints that decide a real deployment. Read all of it before the first one; every item here is
something that is either invisible in the code or expensive to discover in production.

### 11.1 One API process per room. This is not a scaling knob.

`apps/api/src/rooms/registry.ts`: *"the authoritative live state is this process's memory … this
design assumes one API process per room."* ADR 0001 chose that deliberately — the alternative is a
distributed lock on every action, for a play-money teaching app.

The consequence is concrete and unforgiving: **two API processes each holding "the" `HandState`
for one room deal two different hands and resolve the pot differently.** Nothing detects it. The
learner sees a hand that never happened.

So exactly one of these must be true:

1. **One API replica.** `docker-compose.yml` sets `deploy: replicas: 1` and this is why. On any
   orchestrator, pin it there and put the reason next to it. Restarts drop live rooms — hand
   history is already archived to PostgreSQL, so what is lost is the in-progress hand.
2. **Room affinity.** More than one replica requires a router that sends every request and every
   WebSocket for a given room id to the same process, and keeps doing so across reconnects. That
   is a real routing tier, not a load-balancer checkbox: cookie-based stickiness is not enough,
   because the key is the *room*, not the *session* — two players in one room are two sessions
   that must land on one process.

Web is stateless; scale it freely. PostgreSQL is the only durable state.

### 11.2 TLS is mandatory, and it terminates at the proxy

The API refuses to start in production with a plaintext `PUBLIC_WEB_ORIGIN`, and refuses
`COOKIE_SECURE=false`. Both are correct: the session cookie is `__Host-` prefixed, which requires
`Secure`, no `Domain` and `path=/`, and a `Secure` cookie is never sent over plain HTTP.

That makes a terminating reverse proxy a required component, not an option. It must:

* Serve the app on **one** public origin, and route by path — `/api/*` (and `/ws*`) to the API,
  everything else to web. The compose `proxy` service is a working reference; lift its nginx
  config, and replace the `resolver 127.0.0.11` line with your platform's DNS.
* Set `X-Forwarded-For` and `X-Forwarded-Proto`, and **overwrite** any inbound value of them.
* Pass `Origin` through unchanged. The API checks it on CSRF and on every socket upgrade.
* Support WebSocket upgrades on the API path.

Then set, on the API: `NODE_ENV=production`, `PUBLIC_WEB_ORIGIN=https://your-public-origin` (the
proxy's origin — not the API's, not web's), and `TRUST_PROXY=true` **only if** the API is
unreachable except through that proxy. If you publish the API port anywhere else, leave
`TRUST_PROXY` off: a spoofable `X-Forwarded-For` lets a client pick its own rate-limit bucket.

On web: `PRL_API_ORIGIN` pointing at the API on the private network. Nothing else. The browser
gets no API address at all.

### 11.3 Migrations run from outside the serving container

`Dockerfile.api` deliberately omits `apps/api/scripts/`, so the serving image cannot migrate —
that is a decision about not giving a serving process schema-change rights, and it means the
deploy pipeline needs somewhere else to run them from. Any of:

* a CI job on the release commit, with `DATABASE_URL` naming the **`prl_deployer`** role (§5);
* a one-shot job/container built from the repo at the same commit;
* an operator on a bastion, from a checkout at that commit.

The runner takes a PostgreSQL advisory lock, so two concurrent deploys cannot both migrate.
Migrations are checksummed and refuse to reapply an edited file. Order: migrate, then roll the API.
Additive-first schema changes make that order safe; a destructive change needs two releases.

#### Roll-forward only. There is no rollback, and `down` says so.

Plan the deployment around this before the first one, because "we can always roll the schema
back" is false here and the pipeline should not discover that during an incident.

**Why.** A `down` script is code that has, by construction, never run against the database it
is one day asked to save, and the first execution would be during the incident. It also cannot
bring back data a forward migration removed — so in the case that actually needs undoing, the
answer is a restore (§11.4) and not a reversed migration.

**A policy is only real if something enforces it, so two things do.**

*1. `down` is a command that refuses.* Not an unrecognised argument — a deploy pipeline asking
for a rollback gets an answer rather than `Unknown command "down"`, which reads like a version
skew and sends the operator after the wrong problem. Run 2026-08-19:

```
$ node apps/api/scripts/migrate.mjs down ; echo $?
  ✗ There is no `down`. Poker Risk Lab is roll-forward only, and this is the policy, not a
missing feature.
  ...
What to do instead:
  * The schema is wrong          write the next migration. Applied files are immutable;
                                 the fix is 0008, never an edit to 0007.
  * The release is bad           roll the APPLICATION back and leave the schema. Migrations
                                 are additive-first, so the previous release runs against
                                 the newer schema.
  * Data is gone                 restore from backup (§11.4). Nothing this script can do
                                 would recover it.
  * A development database       `reset` drops schema prl and reapplies everything. It
                                 refuses to run with NODE_ENV=production.
1
```

*2. `up` refuses an undeclared destructive migration.* Roll-forward-only is safe exactly as
long as migrations are additive. So `up` scans every **pending** file — with comments stripped
and quoted values blanked, so prose about a `DROP` is not mistaken for one — and aborts,
applying nothing, if any of them contains:

| Statement | Why it is refused |
| --- | --- |
| `DROP TABLE/SCHEMA/DATABASE/SEQUENCE/TYPE/DOMAIN/VIEW/MATERIALIZED VIEW` | drops an object and everything in it |
| `ALTER … DROP COLUMN` / `DROP CONSTRAINT` | drops a column or a constraint |
| `TRUNCATE` | empties a table |
| `DELETE FROM` | deletes rows |
| `… RENAME … TO …` | renames something the currently deployed code still queries by its old name |

The list is deliberately narrow. `DROP INDEX`, `REVOKE` and `ALTER … SET DEFAULT` are absent
because a following migration really can restore them, and a gate that fires on ordinary DDL
is a gate that gets a blanket marker pasted into every file.

**The escape hatch, and its shape.** A migration that genuinely has to destroy something says
so in the file, with a reason, on the marker's own line:

```sql
-- prl:irreversible: the invite_code column has been unused since 0014 and the values are
-- not recoverable; restoring them means restoring a backup.
```

A bare marker is not enough — the regex requires non-empty text after the colon, because the
point of the gate is to make somebody write down what cannot be undone, and a marker with no
sentence after it is a checkbox rather than a decision. The reason must start on the marker's
own line; a marker followed by a newline would otherwise read the next SQL statement as the
justification for deleting the thing it operates on.

**In practice** this means a destructive change is two releases, which is the same answer
§11.3 already gives for deploy ordering: ship the additive half, roll the application onto it,
then ship the removal in a later release carrying the marker.

### 11.4 Backups

The database holds hand history and the audit log — the two things the app promises are
verifiable after the fact. Nothing else in the stack is durable.

**Dump and restore with ownership and privileges intact.** The schema's grants *are* part of the
schema here: `prl` is owned by `prl_migrator` and `prl_app` holds exactly the table-level rights the
request path needs (§5, `db/migrations/0001_initial.sql`). A dump that strips them restores a
database the application cannot read — see the box below, which is what this procedure used to say.

```bash
# Nightly. KEEP ownership and privileges: they are the least-privilege posture, and a
# dump without them restores to a database the API cannot read.
pg_dump --format=custom "$DATABASE_URL" > prl-$(date +%F).dump

# Restore into an empty database.
# 1. The roles are cluster-wide and are NOT in the dump. Create them first, or every
#    ALTER ... OWNER and GRANT in the dump fails.
DATABASE_MIGRATION_URL="$TARGET_ADMIN_URL" node apps/api/scripts/migrate.mjs roles
# 2. Restore. No --no-owner, no --no-privileges. --exit-on-error so a partial restore
#    is a failure rather than a database that looks fine.
pg_restore --dbname="$TARGET_URL" --exit-on-error prl-2026-08-18.dump
# 3. Verify. Both of these now pass, which is the point.
pnpm run db:verify
pnpm run db:migrate:status
```

`pnpm run db:roles` is an alias for step 1 when the environment is already configured.

**Four things that decide whether this works, each of which cost a rehearsal to learn.**

* **The roles are not in the dump.** `pg_dump` of one database never contains a `CREATE ROLE`;
  only `pg_dumpall --globals-only` does. Confirmed against a real dump on 2026-08-19:
  `pg_restore --list` showed **0** `CREATE ROLE` entries and **16** ACL entries, including
  `DEFAULT ACL - DEFAULT PRIVILEGES FOR FUNCTIONS prl_migrator` and
  `ACL - SCHEMA prl prl_migrator`. Those entries are the reason step 1 exists: they have
  nothing to attach to on a fresh cluster.
* **Keep `pg_dumpall --globals-only` alongside each dump anyway.** Step 1 recreates the two
  privilege containers, which is all a *restore of this database* needs. It does not recreate
  the login roles (`prl_api`, `prl_deployer`), their passwords, or anything else cluster-wide —
  so for a full-cluster rebuild the globals dump is the thing you will want and will not be
  able to reconstruct afterwards.
* **The restoring identity must be a member of `prl_migrator`, or a superuser.** The dump
  contains `ALTER SCHEMA prl OWNER TO prl_migrator`, and PostgreSQL will not let a role assign
  ownership to a role it cannot `SET ROLE` to. `migrate.mjs roles` handles this by granting
  `prl_migrator` **to whoever runs it** — so run step 1 as the identity that will run step 2, or
  as a superuser who then grants it. `prl_deployer` (§5) already has the membership. Measured
  2026-08-19 — as `prl_deployer`, `pg_restore --exit-on-error` exits **0** and `db:verify` exits
  0; as `prl_api`, which is a member of `prl_app` and not of `prl_migrator`, it exits **1** with
  `ERROR: must be able to SET ROLE "prl_migrator"` on that exact statement.
* **`--exit-on-error` is what makes that a failure instead of a shape.** Without it, `pg_restore`
  carries on past every rejected statement and finishes with
  `warning: errors ignored on restore: 20`. Measured 2026-08-19: the resulting database has all
  **54** relations in schema `prl` owned by **`prl_api`**, which therefore holds `CREATE` on the
  schema and can `DROP` every table it serves — the entire least-privilege posture, inverted, in a
  database that has every row and every index.

> **`pnpm run db:verify` used to exit 0 on that database, and now does not.** This was a real gap:
> `verify-schema.mjs` check 6 asserts that **`prl_app`** owns no relation and holds no `CREATE` —
> which is true, because ownership landed on `prl_api` instead — and it never asked who *does* own
> schema `prl`. So the one command §11.7 tells you to trust as the restore rehearsal could not see
> this particular broken restore. **Check 6b now closes it**, asserting the schema and every
> relation in it are owned by `prl_migrator`; a restore that lands ownership anywhere else fails
> `db:verify` with the offending relations named. The queries below are the same thing by hand, and
> are worth keeping for a database you cannot run the script against:
>
> ```sql
> select nspname, pg_get_userbyid(nspowner) from pg_namespace where nspname = 'prl';
> -- must answer prl_migrator
> select pg_get_userbyid(relowner), count(*) from pg_class c
>   join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'prl' group by 1;
> -- must be prl_migrator and nothing else
> ```
* **`db:migrate:status` reads `DATABASE_MIGRATION_URL`, not `DATABASE_URL`.** Point it at
  `prl_api` and it answers `permission denied for table schema_migrations`, because the ledger
  is deliberately not readable by the runtime role. Give it the migration identity.

Rehearsed end to end on 2026-08-19 against a migrated and seeded database — dump, `roles`,
`pg_restore --exit-on-error`, then:

```
$ pnpm run db:verify                    # DATABASE_URL naming prl_api
  · 121 columns across the prl schema
  · 41 indexes
  · checked 13 tables for prl_app privileges
  · checked schema and every relation owner
  ✓ every documented schema security property holds      → exit 0

$ pnpm run db:migrate:status            # DATABASE_MIGRATION_URL naming prl_deployer
  applied  0001_initial.sql
  applied  0002_indexes_and_constraints.sql
  · 2 applied and matching, 0 pending                    → exit 0
```

Test the restore on a schedule. A backup nobody has restored is a hypothesis, and `pg_restore`
exiting 0 is not the test — `db:verify` exiting 0 is. `pnpm run db:migrate:status` on the
restored database tells you which release it belongs to.

> **If you inherited a dump taken with `--no-owner --no-privileges`**, the symptom is precise and
> the repair is two steps. Re-measured 2026-08-19 by restoring the same dump both ways:
> `pg_restore --exit-on-error` exits **0** — this is the dangerous part, it looks like a
> successful restore — and then `pnpm run db:verify` exits 1 with
>
> ```
>   · 0 columns across the prl schema
>   · checked 0 tables for prl_app privileges
>   ✗ missing hash column: sessions.token_hash does not exist
>   ✗ missing hash column: rooms.invite_code_hash does not exist
>   ✗ prl_app: lacks USAGE on schema prl, so the app cannot read anything
> ```
>
> The first two lines are the same defect wearing a different hat: a `prl_api` session cannot see
> the schema at all, so `information_schema` returns nothing and every column looks missing.
> `select … from prl.users` as that session answers `ERROR: permission denied for schema prl`.
> Repair, in this order, as a superuser or as the schema's new owner:
>
> ```bash
> psql "$TARGET_ADMIN_URL" -c 'ALTER SCHEMA prl OWNER TO prl_migrator;'
> # Then re-apply the grant block — the section headed "grants" in
> # db/migrations/0001_initial.sql (REVOKE ALL ON SCHEMA prl FROM PUBLIC through the two
> # GRANT EXECUTE lines). It is idempotent.
> sed -n '/^REVOKE ALL ON SCHEMA prl FROM PUBLIC/,/^GRANT EXECUTE ON FUNCTION prl.is_card/p' \
>   db/migrations/0001_initial.sql | psql "$TARGET_ADMIN_URL"
> pnpm run db:verify
> ```
>
> **The `ALTER SCHEMA` alone is not enough** — `db:verify` still exits 1, because `--no-privileges`
> removed the table grants as well as the ownership. Both steps, then re-verify.
>
> Measured on 2026-08-18, and again on 2026-08-19 against a freshly migrated and seeded database,
> to make sure this section is not wrong twice: the old procedure restored with exit 0 and then
> failed `db:verify` (`prl` owned by the dumping superuser, `prl_app` denied); the procedure above
> restored with `prl` owned by `prl_migrator` and `db:verify` exit 0; and the repair above took the
> broken restore to `db:verify` exit 0 with `prl_app` reading rows again.
>
> **No gate enforces any of this.** `db:verify` runs inside `pnpm run verify` against the
> *development* database, which proves the checks work; nothing in the repository restores a dump.
> The rehearsal in §11.7's checklist is a human step and stays one.

### 11.5 Logs

Structured JSON, one line per event, on **stdout** — nothing writes log files, and the root
filesystem is read-only, so nothing can. Collection is the platform's job: the container runtime's
log driver, or a sidecar. Points that matter when you configure it:

* Cookies, tokens, invite codes, OIDC codes and display names are already redacted, and IPs are
  keyed hashes. The stream is not free of personal data, but it is not carrying credentials.
* Every line has a request id, and API error responses return the same id. That correlation is the
  main reason to keep them.
* Set retention deliberately. Hand history lives in PostgreSQL; logs are for incidents.

### 11.6 Health and rollout

* `GET /api/v1/health` — liveness. Cheap, no database.
* `GET /api/v1/ready` — readiness. Checks the database, 503 while degraded. This is the one a load
  balancer should use.
* Web has no health route; `GET /` renders the home page and that is the honest check.
* Both container `HEALTHCHECK`s probe the container's own network address, so "healthy" means
  "reachable", not "a process exists".
* Shutdown is graceful on SIGTERM: in-flight requests are answered, every WebSocket gets a `4503`
  `serverShuttingDown` close frame, the pool and the worker threads are closed, exit 0. Set the
  orchestrator's grace period **above** `SHUTDOWN_GRACE_MS`, never equal to it (§10), and expect
  live rooms to end — see 11.1. A client that sees `4503` can say "the server is restarting" and
  reconnect; a client that sees `1006` is looking at a hard kill, which is what a grace period equal
  to the app's own deadline produces.

### 11.7 The pre-deployment checklist

- [ ] Login roles created and granted (§5); `DATABASE_URL` names `prl_api`, migrations name `prl_deployer`
- [ ] `SESSION_COOKIE_SECRET` generated per environment, from a secret manager, never from `.env.example`
- [ ] `PUBLIC_WEB_ORIGIN` is the proxy's public `https://` origin, exact, no trailing slash
- [ ] `PRL_API_ORIGIN` set on web; **no** `NEXT_PUBLIC_API_ORIGIN` or `PRL_API_REWRITE_ORIGIN` anywhere in a runtime environment
- [ ] Proxy terminates TLS, routes `/api/*` and `/ws*`, overwrites `X-Forwarded-*`, supports upgrades
- [ ] `TRUST_PROXY` matches reality (on only if the API is unreachable except via the proxy)
- [ ] API pinned to one replica, or room affinity implemented and tested with two players in one room
- [ ] Migrations run from outside the serving container, at the release commit
- [ ] **No rollback in the deploy plan.** The schema is roll-forward only (§11.3); the rollback
      path is "roll the application back and leave the schema", and for lost data it is §11.4
- [ ] Any destructive migration in this release carries `-- prl:irreversible: <reason>` and was a
      deliberate decision, not a marker pasted in to get past the gate (§11.3)
- [ ] Backups scheduled **and a restore rehearsed** — rehearsed means `pnpm run db:verify` exited 0
      against the restored database, not that `pg_restore` exited 0 (§11.4)
- [ ] The restore rehearsal used the real procedure: `migrate.mjs roles` first, **no**
      `--no-owner`/`--no-privileges`, `--exit-on-error`, restoring identity a member of
      `prl_migrator` (§11.4)
- [ ] Schema ownership on the restored database checked **by hand** — `db:verify` does not look at
      it and exits 0 on a database whose tables the runtime role owns (§11.4)
- [ ] `pg_dumpall --globals-only` retained alongside the dumps — the login roles and their
      passwords are cluster-wide and are in neither the dump nor `migrate.mjs roles` (§11.4)
- [ ] Logs shipped somewhere with retention set
- [ ] Orchestrator termination grace **above** `SHUTDOWN_GRACE_MS`, never equal to it (§10)
- [ ] `pnpm run verify` green on the release commit — every gate `PASS`, not just an exit code
