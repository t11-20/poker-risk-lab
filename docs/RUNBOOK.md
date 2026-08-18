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
pnpm run security:audit            # 8 gates; must pass before anything else

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
| `pnpm run test` | Unit + integration + script tests. **Needs a database** | ~1–2 min |
| `pnpm run test:unit` | Package and web tests only | ~1 min |
| `pnpm run test:integration` | API tests | seconds |
| `pnpm run test:scripts` | The `scripts/*.mjs` tooling's own tests | seconds |
| `pnpm run test:no-database` | The whole suite with the database waiver applied — see below | ~1 min |
| `pnpm run test:exhaustive` | **All 133,784,560 seven-card hands** against published frequencies | ~7 s |
| `pnpm run test:simulation` | AI-Legends declared traits against a large simulation | ~30 s |
| `pnpm run test:a11y` | Static accessibility audit of the rendered pages | ~30 s |
| `pnpm run test:smoke` | End-to-end smoke against a running stack; `-- --strict` fails on warnings | seconds |
| `pnpm run test:load` | WebSocket load harness against a local server | configurable |
| `pnpm run test:all` | test + exhaustive + simulation + a11y | ~3 min |

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
| `pnpm run security:audit` | **All eight gates. The release gate.** |
| `pnpm run security:audit -- --offline` | Skip network gates — *not* a valid release audit |
| `pnpm run security:policy` | Is the supply-chain policy actually in effect? |
| `pnpm run security:hygiene` | Source encoding, NUL bytes, hidden/bidi characters |
| `pnpm run security:denylist` | Banned packages anywhere in the graph |
| `pnpm run security:shapes` | Resolution shapes, install scripts, exact versions |
| `pnpm run security:ioc` | Shai-Hulud IOC sweep of the tree and the installed store |
| `pnpm run security:provenance` | Lockfile ↔ registry integrity, release-age cooldown |
| `pnpm run security:osv` | OSV.dev vulnerability scan |
| `pnpm run security:sbom` | Generate the CycloneDX 1.6 SBOM |
| `pnpm run deps:quarantine` | Resolve dependencies in a scrubbed, secret-free quarantine |

### Database

| Command | What it does |
| --- | --- |
| `pnpm run db:up` | Start PostgreSQL |
| `pnpm run db:wait` | Block until it accepts connections |
| `pnpm run db:migrate` | Apply pending migrations |
| `pnpm run db:migrate:status` | Show applied and pending |
| `pnpm run db:seed` | Apply dev seeds (**refuses under `NODE_ENV=production`**) |
| `pnpm run db:reset` | Drop and recreate the schema (**refuses under `NODE_ENV=production`**) |
| `pnpm run db:setup` | up → wait → migrate → seed |
| `pnpm run db:down` | Stop PostgreSQL |

### The one command before a release

```bash
pnpm run verify
# security:audit → security:hygiene → lint → build → typecheck → design:contrast → test → db:verify
```

`build` runs **before** `typecheck`, and the order is load-bearing rather than stylistic: every
`@prl/*` package resolves its types through its built `dist/`, so a typecheck on a clean tree with
no `dist/` reports missing modules that a build would have produced. Do not reorder it.

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

> The local stack in `docker-compose.yml` does **not** do this — it connects as the dev superuser
> `poker`, so the least-privilege path is not exercised in development. If you are changing
> repository code that issues SQL, test it against a `prl_app` member before shipping, because a
> missing `GRANT` will not surface locally.

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
`init: true` is set for correct signal handling. Every base image is pinned by digest.

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
`pnpm run build:packages`. Packages resolve through their built `dist/`.

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
* **Graceful shutdown** on SIGTERM/SIGINT: stop accepting, drain in-flight work, close the
  database pool and the equity worker pool, exit 0. It exits non-zero only if the drain genuinely
  fails or the grace period (`SHUTDOWN_GRACE_MS`, default 10 s) expires first.

  Two details an operator plans around. **A keep-alive socket does not hold the drain open.**
  Fastify's `forceCloseConnections: 'idle'` only drops sockets that are idle at the instant SIGTERM
  arrives; a socket that was mid-request is not, and Node would then hold it for the full
  `keepAliveTimeout` (72 s) — far past any deploy grace. So the shutdown path collapses
  `keepAliveTimeout` and sweeps for newly-idle sockets until the drain finishes. **The worker
  threads are closed on the shutdown path itself**, not only through a route module's `onClose`
  hook, because four live worker threads at exit present as a deploy that simply hangs.

  Set the orchestrator's termination grace period above `SHUTDOWN_GRACE_MS`, not below it. Do not
  add retries or a longer grace to compensate for an exit 1 under load: that behaviour was a
  defect and is fixed, and compensating for it now just slows every rollout down.
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

### 11.4 Backups

The database holds hand history and the audit log — the two things the app promises are
verifiable after the fact. Nothing else in the stack is durable.

```bash
# Nightly, retained per your policy. --format=custom so pg_restore can be selective.
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > prl-$(date +%F).dump

# Restore into an empty database, then verify the schema matches what the app expects.
pg_restore --dbname="$TARGET_URL" --no-owner prl-2026-08-18.dump
pnpm run db:verify
```

Test the restore on a schedule. A backup nobody has restored is a hypothesis. `pnpm run
db:migrate:status` on the restored database tells you which release it belongs to.

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
* Shutdown is graceful on SIGTERM (drain, close the pool). Set the orchestrator's grace period
  above the drain timeout, and expect live rooms to end — see 11.1.

### 11.7 The pre-deployment checklist

- [ ] Login roles created and granted (§5); `DATABASE_URL` names `prl_api`, migrations name `prl_deployer`
- [ ] `SESSION_COOKIE_SECRET` generated per environment, from a secret manager, never from `.env.example`
- [ ] `PUBLIC_WEB_ORIGIN` is the proxy's public `https://` origin, exact, no trailing slash
- [ ] `PRL_API_ORIGIN` set on web; **no** `NEXT_PUBLIC_API_ORIGIN` or `PRL_API_REWRITE_ORIGIN` anywhere in a runtime environment
- [ ] Proxy terminates TLS, routes `/api/*` and `/ws*`, overwrites `X-Forwarded-*`, supports upgrades
- [ ] `TRUST_PROXY` matches reality (on only if the API is unreachable except via the proxy)
- [ ] API pinned to one replica, or room affinity implemented and tested with two players in one room
- [ ] Migrations run from outside the serving container, at the release commit
- [ ] Backups scheduled **and a restore rehearsed**
- [ ] Logs shipped somewhere with retention set
- [ ] `pnpm run verify` green on the release commit
