# Agent G — Production & Operations review

**Scope**: clean-room install, configuration, database/migrations, build, startup, browser smoke
test, graceful shutdown, containers, observability, deployment documentation, CI.
**Method**: clean-room copy of the repository (no `node_modules`, no `.env`) installed from the
committed lockfile in `/private/tmp/.../scratchpad/cleanroom`, plus the live services already
running in this environment (API `:3001`, web `:3000`, PostgreSQL 16 in Docker).
**Verdict**: **FAIL**. Six release-blocking defects. The release cannot be built from a clean
checkout, its own release gate fails, neither container image runs, and the deployed front end
never talks to its back end.

Environment: Node v24.18.0, pnpm 11.10.0, corepack 0.35.0, Docker 29.6.1, network available
(registry.npmjs.org 200, OSV reachable).

---

## Contents

- [Summary table](#summary-table)
- [P0 findings](#p0-findings)
- [P1 findings](#p1-findings)
- [P2 findings](#p2-findings)
- [P3 findings](#p3-findings)
- [What passed](#what-passed)
- [What I could not verify](#what-i-could-not-verify)
- [Every command I ran](#every-command-i-ran)

---

## Summary table

| # | Sev | Area | One line |
|---|-----|------|----------|
| G1 | P0 | build | A clean `--frozen-lockfile` install cannot build/typecheck `@prl/api`; works locally only because of six hand-made symlinks in `node_modules` |
| G2 | P0 | release gate | `pnpm run security:audit` fails in a clean room *and* in this repo; CI's first job (which gates all others) would be red on every push |
| G3 | P0 | integration | The web client calls `/api/...`; the API serves `/api/v1/...`. Every call 404s and every page silently renders bundled fixtures |
| G4 | P0 | containers | `Dockerfile.web` runtime stage has the wrong `WORKDIR`; the container exits 1 and crash-loops |
| G5 | P0 | containers | `docker-compose.yml`'s `api` service sets a variable nothing reads, omits the session secret, and omits `HOST`; the container refuses to boot (exit 78) |
| G6 | P0 | journey | `/play` is a static fixture. Fold/Call/Raise are enabled and inert. No hand can be played in a browser |
| G7 | P1 | shutdown | SIGTERM with a request in flight on a keep-alive socket hangs the full 10 s grace and exits 1; worker threads still alive at the deadline |
| G8 | P1 | dev loop | `pnpm run dev` serves HTTP 500 on every route in 4 of 6 clean runs (`Cannot find module '@swc/helpers/_/_interop_require_default'`) |
| G9 | P1 | config | `NEXT_PUBLIC_API_ORIGIN` is undocumented and build-time-inlined, so no deployment can point the web app at its own API |
| G10 | P1 | tooling | `pnpm run test:load` calls three routes that do not exist; 100 % error rate, exit 1 |
| G11 | P2 | database | Docs say connect as `prl_app`; `prl_app` is `NOLOGIN`. The required login-role step is documented nowhere |
| G12 | P2 | CI | No CI job builds a container image or runs compose, so G4 and G5 can never be caught |
| G13 | P2 | docs | The single-API-process constraint, TLS/proxy, backup/restore and log shipping are absent from the operations docs |
| G14 | P2 | config | `.env.example` still ships the stale `8080` port in `OIDC_REDIRECT_URI` |
| G15 | P2 | config | `.env.example` claims `https://*.example` is "rejected at boot"; it is accepted |
| G16 | P3 | docs | `README.md` links `docs/REPORT.md`, which does not exist |
| G17 | P3 | docs | `RUNBOOK.md` §6 tells you to look for a base-image-digest `TODO`; both Dockerfiles are digest-pinned and contain none |
| G18 | P3 | containers | `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` ship inside the production web image |
| G19 | P3 | tests | `packages/contracts` has no test files; its `test` script matches nothing and exits 0 |
| G20 | P3 | build hygiene | `next dev` then `next build` in one checkout leaves 29 dangling chunk references; `next start` then serves a page whose JS 503s (this is the state of `:3000` right now) |
| G21 | P3 | robustness | The boot overlay is driven only by `requestAnimationFrame`, so a hidden tab keeps a full-viewport `pointer-events: auto` overlay up indefinitely |
| G22 | P3 | logging | A routine 403 CSRF rejection logs a full stack trace with absolute filesystem paths |

---

## P0 findings

### G1 — A clean `pnpm install --frozen-lockfile` cannot build or typecheck the API

**Location**: `pnpm-workspace.yaml` (`nodeLinker: isolated`, `hoistPattern: []`,
`publicHoistPattern: []`) + `apps/api/tsconfig.json` (a `paths` mapping exists for `ws` but not
for `fastify`); manifests in `apps/api/package.json`.

**Problem**: every `@fastify/*` plugin declares `fastify` only as a **devDependency**, never a
peer. Under `nodeLinker: isolated` with both hoist patterns empty, `fastify` is therefore not
reachable from inside those packages' directories, so their own `.d.ts` files cannot resolve it.
`skipLibCheck: false` (deliberate, `tsconfig.base.json:45`) makes that fatal, and because the
plugin type augmentations never load, ~20 further errors appear in first-party source
(`reply.setCookie`, `request.session`, `app.csrfProtection`, `websocket`, plus five `TS7006`
implicit-`any`s).

**Reproduction** (clean-room copy, installed from the committed lockfile):

```
$ pnpm install --frozen-lockfile
Lockfile is up to date, resolution step is skipped
Done in 3s using pnpm v11.10.0

$ pnpm run build
apps/api build: src/routes/auth.ts(457,15): error TS2339: Property 'setCookie' does not exist on type 'FastifyReply<...>'.
apps/api build: src/ws/hub.ts(239,9): error TS2353: Object literal may only specify known properties, and 'websocket' does not exist in type 'RouteShorthandOptions<...>'.
apps/api build: ../../node_modules/.pnpm/@fastify+cookie@11.1.2/node_modules/@fastify/cookie/types/index.d.ts(3,36): error TS2307: Cannot find module 'fastify' or its corresponding type declarations.
apps/api build: ../../node_modules/.pnpm/@fastify+csrf-protection@8.0.1/node_modules/@fastify/csrf-protection/types/index.d.ts(5,73): error TS2307: Cannot find module '@fastify/cookie' or its corresponding type declarations.
apps/api build: ../../node_modules/.pnpm/@fastify+helmet@13.1.0/node_modules/@fastify/helmet/types/index.d.ts(1,69): error TS2307: Cannot find module 'fastify' ...
apps/api build: ../../node_modules/.pnpm/@fastify+rate-limit@11.2.0/node_modules/@fastify/rate-limit/types/index.d.ts(11,8): error TS2307: Cannot find module 'fastify' ...
apps/api build: ../../node_modules/.pnpm/@fastify+websocket@11.3.0/node_modules/@fastify/websocket/types/index.d.ts(1,26): error TS2307: Cannot find module 'fastify' ...
apps/api build: Failed
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @prl/api@0.1.0 build: `tsc -p tsconfig.json`
BUILD_EXIT=2

$ pnpm run typecheck
apps/api typecheck: src/plugins/security.ts(596,16): error TS7006: Parameter 'request' implicitly has an 'any' type.
apps/api typecheck: src/plugins/security.ts(626,9): error TS2339: Property 'csrfProtection' does not exist ...
TYPECHECK_EXIT=1

$ docker build -f Dockerfile.api .
 > [build 2/2] RUN pnpm --filter "@prl/api..." run build:
1.390 apps/api build: ... error TS2307: Cannot find module 'fastify' ...
ERROR: failed to build: process "/bin/sh -c pnpm --filter \"@prl/api...\" run build" did not complete successfully: exit code: 2
EXIT=1
```

**Evidence that the working copy is repaired by hand.** The same `tsc` invocation succeeds in
this repo, and the reason is six symlinks that no install created — note the `21:30` mtime
against `19:55` for everything pnpm wrote:

```
$ ls -la node_modules/.pnpm/@fastify+websocket@11.3.0/node_modules | grep fastify
lrwxr-xr-x  1 terence  staff  41 17 Aug 21:30 fastify -> ../../fastify@5.11.3/node_modules/fastify
lrwxr-xr-x  1 terence  staff  54 17 Aug 19:55 fastify-plugin -> ../../fastify-plugin@6.0.0/node_modules/fastify-plugin
```

The same hand-made `fastify` link exists in `@fastify+cookie@11.1.2`, `@fastify+helmet@13.1.0`,
`@fastify+rate-limit@11.2.0`, `@fastify+csrf-protection@8.0.1` (which also gained a hand-made
`@fastify/cookie`), all at `21:30`. The clean-room tree has none of them:

```
$ ls -la $CLEANROOM/node_modules/.pnpm/@fastify+websocket@11.3.0/node_modules
drwxr-xr-x  @fastify
lrwxr-xr-x  duplexify -> ...
lrwxr-xr-x  fastify-plugin -> ...
lrwxr-xr-x  ws -> ...
```

The lockfile is not stale — `pnpm install --no-frozen-lockfile` reports "Lockfile is up to date"
and produces a zero-line diff — so this is not fixable by re-resolving. `pnpm-lock.yaml:1046`
confirms the recorded dependency set contains no `fastify`:

```yaml
  '@fastify/websocket@11.3.0':
    dependencies:
      duplexify: 4.1.3
      fastify-plugin: 6.0.0
      ws: 8.21.3
```

**Blast radius**: `pnpm run build`, `pnpm run typecheck`, `pnpm run verify`,
`docker build -f Dockerfile.api .`, `docker compose build api`, and CI's `typecheck`, `build`
and `a11y` jobs. `pnpm run test` still passes because Node 24 strips types at runtime, which is
why the running server works.

**Fix**: solve it the way `apps/api/tsconfig.json` already solves the identical problem for `ws`
— add `paths` entries mapping `fastify` (and `@fastify/cookie`) at the API's own
`node_modules` — or add a narrow `hoistPattern` in `pnpm-workspace.yaml`. Then delete the
hand-made symlinks and prove the build from a scratch install. Do not leave them: they are
invisible to `git`, to the lockfile, and to `verifyDepsBeforeRun`.

**Missing test**: a CI job that installs into an empty store
(`pnpm store prune && rm -rf node_modules && pnpm install --frozen-lockfile`) and then runs
`pnpm run build` — plus a container-build job (see G12).

---

### G2 — The declared release gate fails, in a clean room and in this repo

**Location**: `scripts/supply-chain/policy-check.mjs:93-101` (shells out to
`pnpm config list --json`), reached via `package.json` scripts `security:policy` /
`security:audit`; consumed by `.github/workflows/ci.yml:117` and
`.github/workflows/supply-chain.yml:94`.

**Problem**: pnpm injects `pnpm_config_verify_deps_before_run=false` into the environment of any
script it runs (so nested pnpm invocations do not re-verify). The gate spawns `pnpm config list
--json` from inside that environment, the child reports `verifyDepsBeforeRun = false`, and the
gate fails. The setting *is* correctly configured; the gate is measuring its own wrapper.

**Reproduction**:

```
$ pnpm run security:audit      # in the clean room
▸ policy in effect
  · 12 policy settings asserted against pnpm's effective config
  · packageManager pinned with integrity hash (pnpm@11.10.0)
  ✗ policy setting not in effect: verifyDepsBeforeRun = false
      required because: refuse to run against a stale node_modules
  ✗ policy-in-effect — 1 failure(s)
...
Summary
  ✗ FAIL  policy in effect
  ✓ pass  source encoding hygiene
  ✓ pass  denied packages
  ✓ pass  dependency shapes
  ✓ pass  Shai-Hulud IOC sweep
  ✓ pass  integrity + release age
  ✓ pass  OSV vulnerabilities
  ✓ pass  SBOM generation

1 gate(s) failed — this is release-blocking.
exit 1

$ pnpm run security:policy ; echo $?      # in THIS repo
  ✗ policy setting not in effect: verifyDepsBeforeRun = false
1
```

**Evidence of the mechanism** — the same gate passes when not wrapped, and the injected variable
is visible:

```
$ node scripts/supply-chain/policy-check.mjs
  · 12 policy settings asserted against pnpm's effective config
  ✓ policy-in-effect — pass
DIRECT_EXIT=0

$ pnpm config list --json | grep verifyDeps        # plain shell
verifyDepsBeforeRun = "error"

$ pnpm exec env | grep -i verify_deps
pnpm_config_verify_deps_before_run=false
```

**Blast radius**: `pnpm run verify` stops at step one. In CI the `supply-chain` job fails, and
`lint`, `typecheck`, `test`, `exhaustive`, `build` and `a11y` all declare `needs: supply-chain`,
so **no CI job ever runs to completion**. `README.md:54` and `RUNBOOK.md:27` both instruct the
reader to run this first, before anything else.

**Fix**: strip `pnpm_config_*` / `npm_config_*` from the child environment before spawning
(`execFileSync('pnpm', [...], { env: filtered })`), or read the effective config through
pnpm's API rather than a subprocess. Whichever is chosen, the gate must be asserted from inside
a `pnpm run` wrapper, because that is how it is invoked everywhere.

**Missing test**: a test for `policy-check.mjs` that runs it through `pnpm run` (not `node`) and
asserts it passes on a correctly configured workspace, and fails when a policy key is moved into
`.npmrc`.

---

### G3 — The web client and the API do not share an URL space; every call 404s

**Location**: `apps/web/src/lib/api.ts:306`, `apps/web/src/lib/learn-data.ts:37-43`,
`apps/web/src/lib/legends-data.ts:44-51` versus `apps/api/src/app.ts:55`
(`export const API_PREFIX = '/api/v1'`).

**Problem**: the client's paths are marked in-source as "**Provisional** endpoint paths. The API
team owns the final names" and were never reconciled. They omit the version segment, and several
resource names differ as well. Every screen therefore takes the fixture branch and the whole
front end runs disconnected. Nothing surfaces this: the fallback copy reads as a transient
outage.

**Reproduction**. I built the web app clean (`NEXT_PUBLIC_API_ORIGIN=http://localhost:3101`),
served it on `:3200`, ran a private API on `:3101` with a matching origin allowlist, visited
`/`, `/play`, `/lab`, `/review`, `/learn`, `/legends`, and read the API's own request log. The
first three lines are my own `curl` checks with the correct prefix; every line after them is the
web app:

```
GET   /api/v1/health          <- my curl, 200
GET   /api/v1/ready           <- my curl, 200
GET   /api/v1/content/lessons <- my curl, 200
GET   /api/session            <- web app, 404
GET   /api/session            404
GET   /api/scenarios          404
GET   /api/session            404
GET   /api/hands              404
GET   /api/session            404
GET   /api/content/lessons    404
GET   /api/session            404
GET   /api/legends/profiles   404
GET   /api/session            404

=== non-200 responses ===
   3 "statusCode":200
  10 "statusCode":404
```

The user-visible result on `/legends`:

> **WATCH OUT — These profiles are bundled sample data.** The profile service is not reachable,
> so this page is rendering the bundled sample profiles. … *(That lesson, quiz or scenario does
> not exist.)*

Two further problems visible in that one banner: the trailing sentence is the `content_not_found`
message leaking onto a legends page, and the fallback disagrees with the API — the page shows
"8 profiles · Naming: **attributed**" while `GET /api/v1/legends/profiles` returns
"12 profiles, naming mode **archetype**" (the safe default the smoke test asserts).

**Mapping that has to be fixed** (client → what exists):

| Web client calls | API route |
|---|---|
| `GET /api/session` | `GET /api/v1/auth/session` |
| `GET /api/content/lessons` | `GET /api/v1/content/lessons` |
| `GET /api/content/lessons/:id` | `GET /api/v1/content/lessons/:id` |
| `GET /api/content/glossary` | `GET /api/v1/content/glossary` |
| `GET /api/legends/profiles` | `GET /api/v1/legends/profiles` |
| `GET /api/legends/compare` | `POST /api/v1/legends/compare` |
| `GET /api/legends/:id/learn` | `GET /api/v1/legends/profiles/:profileId` |
| `GET /api/legends/hands/:id/comparison` | *(no such route)* |
| `GET /api/scenarios` | `GET /api/v1/content/scenarios` |
| `GET /api/hands` | `GET /api/v1/hands` |

Note it is not a prefix-only fix: two paths have no server-side counterpart and three have
different shapes or verbs.

**Fix**: export the prefix and the route paths from `@prl/contracts` and have both sides import
them, so a rename cannot diverge again. Then make the fixture fallback *loud* in non-production
(a build-time or boot-time assertion that every client path exists in the contract), because a
silent fixture fallback is what let this ship.

**Missing test**: a contract test that enumerates every path the web client can request and
asserts each one is a registered API route; plus one end-to-end check that
`GET /` renders live content and not the fixture (assert on a value only the database can
supply).

---

### G4 — The web container cannot start: wrong `WORKDIR` in the runtime stage

**Location**: `Dockerfile.web:97-133`. The runtime stage inherits `WORKDIR /app` from `base`
(line 59) and the CMD is `["/app/apps/web/node_modules/.bin/next", "start"]`. `next start`
resolves `.next` relative to the working directory, i.e. `/app/.next`, which does not exist.

**Reproduction**:

```
$ docker build -f Dockerfile.web -t prl-web-review:g .     # builds fine, 51s, EXIT=0
$ docker run --rm prl-web-review:g
▲ Next.js 16.3.0
✓ Ready in 77ms
✓ Running next.config took 7ms
Error: Could not find a production build in the '.next' directory. Try building your app with
'next build' before starting the production server.
$ docker ps -a --filter name=prl-web-g --format '{{.Status}}'
Exited (1) 20 seconds ago
```

Following the runbook's own container instructions:

```
$ WEB_PORT=3300 docker compose up -d --no-deps web
$ docker compose ps --format '{{.Service}} {{.Status}}'
postgres Up 3 hours (healthy)
web      Restarting (1) 2 seconds ago
$ docker compose logs web | tail -3
web-1  | ✓ Running next.config took 9ms
web-1  | Error: Could not find a production build in the '.next' directory. ...
```

**Evidence it is the working directory and nothing else** — the identical image, read-only root
filesystem and both tmpfs mounts, with `-w` added:

```
$ docker run -d -w /app/apps/web --read-only --init \
    --tmpfs /tmp:mode=1777,noexec,nosuid,size=64m \
    --tmpfs /app/apps/web/.next/cache:mode=0700,uid=1000,gid=1000,size=256m \
    -p 127.0.0.1:3211:3000 prl-web-review:g
$ docker ps -a --format '{{.Status}}'   ->  Up 10 seconds (healthy)
$ curl -o /dev/null -w "%{http_code}" http://127.0.0.1:3211/        ->  200
$ curl -o /dev/null -w "%{http_code}" http://127.0.0.1:3211/learn   ->  200
```

Note the first failing run also logged `✓ Running next.config took 7ms` while the working run
logged `✓ Running next.config**.ts** took 26ms` — from `/app` it never found the config file
either.

**Fix**: add `WORKDIR /app/apps/web` to the runtime stage (or `working_dir:` in compose). The
`restart: unless-stopped` policy turns this into an endless crash loop rather than a single
visible failure, so it also deserves a startup smoke check.

**Missing test**: a CI job that builds both images and runs each container until its
`HEALTHCHECK` reports healthy (the web `HEALTHCHECK` would have caught this had anything ever
run the container).

---

### G5 — The API container refuses to boot: compose sets a variable nothing reads, and omits two required ones

**Location**: `docker-compose.yml:122-131` (`api.environment`), and `Dockerfile.api:173-174`
(no `HOST`).

**Problem**, three defects in one block:

1. `PRL_ALLOWED_ORIGINS` is set. **Nothing in the repository reads it** — the API reads
   `PUBLIC_WEB_ORIGIN` (`apps/api/src/config.ts:283`). `grep` finds `PRL_ALLOWED_ORIGINS` in
   exactly one file, `docker-compose.yml` itself.
2. `SESSION_COOKIE_SECRET` is never set, while `NODE_ENV: production` is. Config refuses to boot
   in production without it (correctly).
3. `HOST` is never set, and the default is `127.0.0.1`
   (`apps/api/src/config.ts:499`). `.env.example:33-35` says in as many words: "In a container
   set 0.0.0.0". `Dockerfile.web` sets `HOSTNAME=0.0.0.0` for Next; `Dockerfile.api` sets no
   equivalent. Worse, the `HEALTHCHECK` probes `http://127.0.0.1:${PORT}` *inside* the container,
   so the container would report **healthy** while being unreachable from the compose network
   and from the published port.

**Reproduction** — the exact rendered compose environment, handed to the same config code:

```
$ docker compose config | sed -n '/^  api:/,/^  web:/p'
    environment:
      DATABASE_URL: postgres://poker:poker-dev-only@postgres:5432/poker_risk_lab
      NODE_ENV: production
      PORT: "3001"
      PRL_ALLOWED_ORIGINS: http://127.0.0.1:3000,http://localhost:3000

$ env -i PATH=$PATH DATABASE_URL='postgres://poker:poker-dev-only@postgres:5432/poker_risk_lab' \
    NODE_ENV=production PORT=3001 \
    PRL_ALLOWED_ORIGINS='http://127.0.0.1:3000,http://localhost:3000' \
    node src/server.ts
Refusing to start: 2 configuration problems.
  - PUBLIC_WEB_ORIGIN is required in production (comma-separated allowlist)
  - SESSION_COOKIE_SECRET is required in production; generate one with `node -e "..."`
EXIT=78
```

And with those two supplied, the bind address is still loopback:

```
$ node -e "import('./src/config.ts').then(({loadConfig})=>{const c=loadConfig({...});console.log(c.host, c.port)})"
host = 127.0.0.1  port = 3001
```

**Fix**: rename the compose variable to `PUBLIC_WEB_ORIGIN`, require
`SESSION_COOKIE_SECRET` from the environment (compose can pass it through without a default so a
missing one fails loudly), and set `HOST: 0.0.0.0` for the api service (or in `Dockerfile.api`'s
runtime `ENV`, alongside the existing `PORT`). Consider making the API's healthcheck probe the
address it actually bound, so "healthy but unreachable" cannot happen.

**Missing test**: a compose smoke test in CI — `docker compose up -d`, wait for both services
`healthy`, then `curl` `/api/v1/health` on the published port and `/` on the web port. Also a
config test asserting that every variable named in `docker-compose.yml` is one `loadConfig`
actually reads.

---

### G6 — `/play` is a static fixture; no hand can be played in the browser

**Location**: `apps/web/src/app/play/page.tsx:11-23` and `apps/web/src/fixtures/table.ts:6`.

**Problem**: the flagship journey is unimplemented in the UI. The page's own header comment says
so: "The API and the WebSocket that will feed this route are being built in parallel with it. So
the screen renders from `src/fixtures/table.ts`". The page has **zero** references to the API
client. The Fold / Call / Raise buttons are rendered **enabled**, and clicking them does nothing.
The requirement list bans exactly this ("No placeholder auth, fake multiplayer, …").

**Reproduction** (clean build on `:3200`, private API on `:3101`, DOM inspected in Chrome):

```
Page text, last line of /play:
  FIXTURE STATES — NO SERVER IS CONNECTED

Buttons found (none disabled):
  {"text":"Fold0 units","disabled":false}
  {"text":"Call35 units","disabled":false}
  {"text":"Raise to 7070 units","disabled":false}

Clicking Call:
  before    { url: "http://localhost:3200/play", pot: "100" }
  afterCall { url: "http://localhost:3200/play", pot: "100" }   // no change, no request
```

The API log for the same period shows no request at all from the click.

**Evidence the server side does work**, so this is a front-end gap and not a missing engine:
`pnpm run test:smoke` passes 37 checks against the live API including guest sessions, room
creation, invite-only joins and hand-history isolation; and `apps/api` integration tests exercise
WebSocket actions, redaction and idempotency.

**Fix**: wire `/play` to `POST /api/v1/rooms`, `POST /api/v1/rooms/:roomId/sit` and the
WebSocket at `/api/v1/ws`, using the frames in `@prl/contracts`. Until then the action buttons
must be `disabled` with a visible reason — an enabled button that silently does nothing is worse
than a disabled one.

**Missing test**: an end-to-end test that creates a guest session, sits at a bot table, and
completes one hand through the UI, asserting the pot changes; and a lint/CI rule that fails the
build if a route under `apps/web/src/app` imports from `src/fixtures/` in a production build.

---

## P1 findings

### G7 — Graceful shutdown times out and exits 1 whenever a request is in flight on a keep-alive socket

**Location**: `apps/api/src/server.ts:48-74` (`shutdown`), interacting with
`apps/api/src/plugins/security.ts:481` (`forceCloseConnections: 'idle'`) and
`apps/api/src/routes/calc.ts:119` (the `onClose` hook that terminates worker threads).

**Problem**: `forceCloseConnections: 'idle'` calls Node's `closeIdleConnections()` **once**, at
close time. A socket that was mid-request at SIGTERM is not idle at that moment and is never
revisited, so `app.close()` never resolves, the `onClose` hook never runs, the worker threads are
never terminated, and the 10 s deadline fires with `process.exit(1)`. Browsers always use
keep-alive, so this is the normal case, not the exotic one.

Both `RUNBOOK.md:232` and `ARCHITECTURE.md:277` state the opposite: "exits non-zero **if the
drain fails**". Here the drain succeeded — the in-flight request was answered `200` — and the
process still exited non-zero.

**Reproduction** (three modes, same script, `samples: 500000` Monte Carlo request):

```
########## mode=never (pool never used) ##########
mode=never    exit={"code":0}  after 6 ms
  "reason":"SIGTERM","msg":"shutting down"
  "reason":"SIGTERM","msg":"shutdown complete"

########## mode=after (pool used, request finished) ##########
equity finished: 200
mode=after    exit={"code":0}  after 25 ms
  "msg":"shutting down"  /  "msg":"shutdown complete"

########## mode=inflight (SIGTERM 150 ms into the request) ##########
mode=inflight exit={"code":1}  after 10022 ms
  "reason":"SIGTERM","msg":"shutting down"
  "level":50,"reason":"SIGTERM","graceMs":10000,"msg":"shutdown timed out; exiting hard"
```

**Evidence the workers are still alive at the deadline** — Node diagnostic report taken with
SIGUSR2 three seconds into the hang:

```
report: report.20260818.010631.6905.0.001.json
  libuv handles that are referenced and active:
    timer  0x0000000b2511ccc8
    tcp    0x0000000b24f6d770
    tcp    0x0000000b24f6daf0
  worker threads in report: 4
    worker header threadId: 1  (async, active)
    worker header threadId: 2  (async, active)
    worker header threadId: 3  (async, active)
    worker header threadId: 4  (async, active)
  equity http status: 200 trials: 200000     <- the response WAS delivered
exit code: 1
```

**Evidence the cause is the keep-alive socket** — the identical in-flight test with a single
header added:

```
### inflight WITH "Connection: close" ###
equity still in flight
mode=inflight exit={"code":0}  after 57 ms
  "msg":"shutting down"  /  "msg":"shutdown complete"
```

**Impact**: every rolling deploy that overlaps a Coach or equity request takes the full grace
period and reports a non-zero exit. Kubernetes counts that toward `CrashLoopBackOff`; compose's
`restart: unless-stopped` restarts it; and an operator reading the docs will believe the drain
failed when it did not.

**Fix**: after `app.close()` starts, keep dropping newly-idle sockets (repeat
`server.closeIdleConnections()` on an interval, or drop `keepAliveTimeout` to ~0 for the duration
of the shutdown), and close the worker pool on the shutdown path rather than only through the
Fastify `onClose` hook so a stuck `app.close()` cannot strand threads. Then align the RUNBOOK and
ARCHITECTURE wording with what the code does.

**Missing test**: an integration test that starts the app, issues a request that is still running,
sends SIGTERM, and asserts (a) the in-flight response completes, (b) the process exits 0, and
(c) it exits in well under `SHUTDOWN_GRACE_MS` — with the client using keep-alive, because the
`Connection: close` variant passes and would hide the bug.

---

### G8 — `pnpm run dev` serves HTTP 500 on every route in most clean runs

**Location**: the interaction of `pnpm-workspace.yaml` (`nodeLinker: isolated`,
`hoistPattern: []`, `publicHoistPattern: []`) with Next 16's Turbopack dev externals. Same root
cause family as G1, but at runtime.

**Problem**: Turbopack's dev-mode externals chunk requires
`next/dist/compiled/next-server/app-page-turbo.runtime.dev.js` resolved through the workspace
symlink path (`apps/web/node_modules/next/...`) rather than the store realpath. From there
`@swc/helpers` — a transitive dependency of `next`, present in the store and linked into
`next`'s own isolated directory — is not reachable, and every page render throws.

**Reproduction** — six runs, each after `rm -rf .next`, across two independent clean-room copies
of the same install:

```
cleanroom run0 -> HTTP 500  (Cannot find module '@swc/helpers/_/_interop_require_default')
cleanroom retry -> HTTP 500 (req1 and req2 both 500; 4 swc errors logged)
cleanroom run1 -> HTTP 200
cleanroom run2 -> HTTP 500  (swc errors: 2)
cr2 run0      -> HTTP 200
cr2 run1      -> HTTP 500  (swc errors: 2)
cr2 run2      -> HTTP 500  (swc errors: 2)
```

Log excerpt:

```
⨯ Error: Failed to load external module next/dist/compiled/next-server/app-page-turbo.runtime.dev.js:
  Error: Cannot find module '@swc/helpers/_/_interop_require_default'
Require stack:
- .../apps/web/node_modules/next/dist/client/lib/console.js
- .../apps/web/node_modules/next/dist/server/node-environment.js
- .../apps/web/.next/dev/server/chunks/ssr/[externals]__05yr04l._.js
- .../node_modules/.pnpm/next@16.3.0_.../node_modules/next/dist/server/require.js
 GET / 500 in 1305ms
```

**Evidence of the resolution asymmetry** — the module resolves from the store path and not from
the workspace symlink path:

```
FAIL  .../apps/web/node_modules/next/dist/client/lib/console.js
        -> MODULE_NOT_FOUND Cannot find module '@swc/helpers/_/_interop_require_default'
OK    .../node_modules/.pnpm/next@16.3.0_.../node_modules/next/dist/client/lib/console.js
        -> .../@swc+helpers@0.5.15/node_modules/@swc/helpers/cjs/_interop_require_default.cjs
```

`@swc/helpers@0.5.15` does export `./_/_interop_require_default` (110 export keys, the file is on
disk), so this is purely a resolution-root problem.

**Impact**: the last line of both the README quick start and RUNBOOK §2 is `pnpm run dev`. Two
thirds of new contributors will see a 500 page and a stack trace pointing inside `next`.
`next build` + `next start` is unaffected.

**Fix**: add `@swc/helpers` to the web app's own dependencies, or add a narrow `hoistPattern`
(e.g. `['@swc/helpers']`) in `pnpm-workspace.yaml`. Whichever is chosen, document it next to the
`nodeLinker: isolated` comment, because this is the second runtime consequence of that setting.

**Missing test**: a CI job that starts `next dev`, requests `/` and `/learn`, and asserts 200 —
repeated enough times (or with the cache cleared) to catch a flaky resolution.

---

### G9 — `NEXT_PUBLIC_API_ORIGIN` is undocumented and cannot be set at deploy time

**Location**: `apps/web/src/lib/api.ts:42`
(`process.env['NEXT_PUBLIC_API_ORIGIN'] ?? 'http://localhost:3001'`); absent from
`.env.example` and from `RUNBOOK.md` §7; `docker-compose.yml:172` sets `PRL_API_ORIGIN` instead,
which the web app does not read.

**Problem**: this is the only variable that decides where a browser sends every API request, and

1. it appears nowhere in the configuration documentation (I enumerated every `process.env` read
   in `apps`, `packages` and `scripts` and cross-checked against `.env.example`; this is the one
   gap that matters);
2. `NEXT_PUBLIC_*` is **inlined at build time**, so setting it in the container environment has
   no effect — the value baked into the image is whatever the build saw;
3. `docker-compose.yml:163-172` claims "the web app proxies `/api/*` to this origin rather than
   the browser calling a second host". There is no proxy: `apps/web/next.config.ts` has no
   `rewrites` (and its header says "Deliberately absent: any … redirect"), and `API_ORIGIN` is an
   absolute origin. The stated cookie rationale (`__Host-` + `SameSite=Strict` requiring
   same-origin) therefore does not hold in the shipped topology.

**Reproduction**:

```
$ NEXT_PUBLIC_API_ORIGIN=http://localhost:3101 node_modules/.bin/next build
$ grep -ro "http://localhost:3101" .next/static | head -1
.next/static/chunks/15u1aolqncubd.js:http://localhost:3101      # baked into a client chunk

$ grep -rn "PRL_API_ORIGIN" --include=* . | grep -v node_modules
docker-compose.yml:172
scripts/smoke-test.mjs:26
scripts/a11y-audit.mjs:1352
# nothing in apps/web
```

**Fix**: decide the topology and make it real. Either add a `rewrites` proxy in
`next.config.ts` so the browser only ever talks to the web origin (which is what the cookie
design and the compose comment assume), or keep the two-origin model, document
`NEXT_PUBLIC_API_ORIGIN` in `.env.example` and RUNBOOK §7, pass it as a Docker **build arg**, and
delete the misleading compose comment and the dead `PRL_API_ORIGIN`.

**Missing test**: a config test asserting that every variable in `.env.example` is read
somewhere and every variable read somewhere is in `.env.example` (with an explicit allowlist for
`NO_COLOR` and friends).

---

### G10 — `pnpm run test:load` cannot complete a single operation

**Location**: `scripts/load-test.mjs:88-93`.

**Problem**: the harness's path table is wrong: `'/api/v1/session/guest'` (API:
`/api/v1/auth/guest`), `'/api/v1/session'` (API: `/api/v1/auth/session`), and
`` `/api/v1/rooms/${roomId}/join` `` (API: `POST /api/v1/rooms/join` with the id in the body).
The POST to the non-existent guest path is rejected by the CSRF hook before routing, which is why
the error reads `csrf_failed` rather than `404` and is easy to misread as a client problem.

**Reproduction** (against a healthy private API — `health ok version 0.1.0` is printed by the
harness itself):

```
$ node scripts/load-test.mjs --base-url http://127.0.0.1:3101 --origin http://localhost:3200 \
      --tables 1 --seats 3 --hands 3 --timeout 90
  health   ok  version 0.1.0
  x table 0 failed: POST /api/v1/session/guest -> 403 csrf_failed
Results
  guest sessions          0
  hands completed         0 of 3
  actions sent/applied    0 / 0
Errors
      1  csrf_failed
      1  transport:table-failed
  rate 100.000% of 2 operations
FAIL
  - completed 0 of 3 hands
  - error rate 100.00% exceeds the 1.00% threshold
EXIT=1
```

`RUNBOOK.md:71` lists this as a supported command, and its own header offers it as a CI gate
("Thresholds … exceeding either exits non-zero, so this can gate CI"). It has evidently never
been run against this API.

**Fix**: import the paths from `@prl/contracts` (same fix as G3) rather than restating them, and
add the harness to CI with a tiny shape (`--tables 1 --seats 2 --hands 1`) so it cannot rot.

**Missing test**: the CI job above. A harness that has never completed one hand is not a
regression check.

---

## P2 findings

### G11 — The documented database identity cannot log in, and the real step is undocumented

**Location**: `RUNBOOK.md:142-144` and `:169` ("`DATABASE_URL` — Connect as `prl_app`, not as the
owner"), against `db/migrations/0001_initial.sql:98-104` which creates both roles `NOLOGIN` with
no password.

**Reproduction**:

```
$ docker exec ... psql -U poker -d postgres -c \
    "select rolname, rolcanlogin from pg_roles where rolname in ('poker','prl_app','prl_migrator');"
   rolname    | rolcanlogin
--------------+-------------
 poker        | t
 prl_migrator | f
 prl_app      | f

$ docker exec ... psql -U prl_app -d prl_review_g -c "select 1"
psql: error: FATAL:  password authentication failed for user "prl_app"
```

The migration comment explains the intent — the roles are privilege containers and "the real
login identities … are granted membership out of band, by whatever manages secrets" — but no
document tells a deployer to do that, or how. Following the runbook literally produces a boot
failure.

**The privileges themselves are genuinely correct.** I created a login role, granted it `prl_app`,
and it was refused everything the migration says it must be refused:

```
$ psql -U prl_app_login_g -d prl_review_g -c "create table prl.evil_g(x int);" ...
ERROR:  permission denied for schema prl
ERROR:  permission denied for schema public
ERROR:  permission denied for table users            (truncate)
ERROR:  must be owner of table users                 (drop)
ERROR:  must be owner of table users                 (alter)
ERROR:  permission denied for table schema_migrations (select)
ERROR:  permission denied for table hands            (delete)
ERROR:  permission denied for table audit_log        (delete)
ERROR:  permission denied for database prl_review_g  (create schema)
 count
-------
     0        <- select on prl.users succeeded, as designed
```

**Secondary point**: nothing in this repository ever exercises that role. `.env` and
`docker-compose.yml:128` both connect as `poker` (a superuser), and `ci.yml:232` connects as
`postgres`. The least-privilege design is verified only statically by `pnpm run db:verify`
(which passes: "121 columns … 41 indexes … checked 13 tables for prl_app privileges … every
documented schema security property holds").

**Fix**: add a "Production database setup" section giving the exact statements
(`CREATE ROLE prl_api LOGIN PASSWORD …; GRANT prl_app TO prl_api;` plus the same for the migrator),
and correct RUNBOOK §7 to say "connect as a login role that is a member of `prl_app`". Consider
making compose use such a role so the privilege set is exercised in development.

**Missing test**: an integration test that runs the API's own repository layer against a
connection whose role is only a member of `prl_app`, so a query needing an ungranted privilege
fails in CI rather than in production.

---

### G12 — Nothing in CI builds a container or runs compose

**Location**: `.github/workflows/ci.yml` — jobs are `supply-chain`, `lint`, `typecheck`, `test`,
`exhaustive`, `build`, `a11y`. There is no `docker build`, no `docker compose`, and no image
smoke test.

**Problem**: containers are a required deliverable, and both are broken (G4, G5) in ways a
30-second job would have caught. `pnpm run build` is not a substitute: it does not exercise the
Dockerfiles' prune lists, the runtime stage's working directory, the compose environment, or the
`HEALTHCHECK`s.

**Reproduction**: `grep -c "docker" .github/workflows/*.yml` → the only matches are the
digest-pinned `postgres:16-bookworm` service images.

Otherwise the workflows are in good shape and I want to say so: every `uses:` is a 40-character
commit SHA with the version in a comment, `permissions: contents: read` at the top level and
nowhere widened, `persist-credentials: false` on every checkout, no `continue-on-error` on any
gate, no `|| true`, `if: always()` used only for artifact upload, and `needs: supply-chain`
genuinely gating. The gates are real — which is exactly why G2 makes the whole workflow red.

**Fix**: add a `containers` job that builds both images, `docker compose up -d`, waits for
`healthy`, and curls `/api/v1/health` and `/`.

**Missing test**: that job.

---

### G13 — Deployment documentation is missing the constraints that decide a deployment

**Location**: `docs/RUNBOOK.md` (no deployment section), `docs/ARCHITECTURE.md` §14.

Not documented anywhere an operator would look:

1. **Only one API process may serve a room.** `apps/api/src/rooms/registry.ts:11-16` is explicit
   — "the authoritative live state is this process's memory … this design assumes one API process
   per room … two processes each holding 'the' `HandState` for one room would deal two different
   hands." ADR 0001 chose it. `RUNBOOK.md` never mentions it, `docker-compose.yml` has no
   `deploy.replicas: 1`, and there is no note about session affinity. A competent engineer
   deploying from the docs alone could put two replicas behind a load balancer and misresolve
   pots.
2. **TLS and reverse proxy.** Production requires `https` origins
   (`config.ts:307-316`) and `Secure` cookies, so a terminating proxy is mandatory, but nothing
   says how to configure it, nor how it interacts with `TRUST_PROXY` (whose own warning is good).
3. **Backup and restore.** The database holds hand history and audit log; there is no backup,
   restore or retention guidance, and no `pg_dump` example.
4. **Migrations at deploy time.** `Dockerfile.api:93-97` deliberately omits
   `apps/api/scripts/`, so migrations must run from outside the serving container. That is a
   sound decision, but the runbook does not tell a deployer what to run them *from*.
5. **Log shipping / retention.** RUNBOOK §10 describes the log format but not where logs go.
6. **`ARCHITECTURE.md:277` and `RUNBOOK.md:232` state shutdown behaviour that G7 shows is wrong.**

**Fix**: add a `docs/DEPLOYMENT.md` (or a RUNBOOK section) covering: one API replica, proxy and
TLS, the `prl_app` login-role step from G11, the `NEXT_PUBLIC_API_ORIGIN` build arg from G9,
migration ownership, backups, and log destinations.

**Missing test**: not testable; but a docs-link and docs-claim checklist in CI would have caught
G16 and G17 below.

---

### G14 — `.env.example` still carries the stale `8080` port

**Location**: `.env.example:126` — `#OIDC_REDIRECT_URI=http://localhost:8080/api/v1/auth/oidc/callback`.

`PORT=3001` is set 96 lines above it, with a comment explaining that exactly this disagreement
("the API listened on 8080 while the browser called 3001") was a real bug. A redirect URI must
match the API's actual origin exactly or the OIDC exchange fails, and this is the value a
first-time configurer will copy. `apps/api/test/config.test.ts:315` also bakes `8080` into its
fixture, which normalises the wrong value.

**Fix**: change to `http://localhost:3001/api/v1/auth/oidc/callback` here and in the test
fixture.

**Missing test**: a check that no port other than the configured `PORT` appears in an
`OIDC_REDIRECT_URI` example.

---

### G15 — `.env.example` claims wildcard origins are rejected at boot; they are accepted

**Location**: `.env.example:47-50` — "No trailing slash, no wildcard. … `https://app.example/`
and `https://*.example` are rejected at boot" — against
`apps/api/src/config.ts:260-280` (`normaliseOrigin`), which validates scheme, credentials, query,
fragment and path but never the host shape.

**Reproduction**:

```
$ node -e "import('./src/config.ts').then(({normaliseOrigin,loadConfig})=>{ ... })"
"https://*.example"          => {"origin":"https://*.example"}      <- accepted
"https://app.example/"       => {"origin":"https://app.example"}    <- correctly normalised
"https://app.example?x=1"    => {"problem":"... must not contain a query string or fragment"}
BOOTED with webOrigins = [ 'https://*.example' ]
```

**Impact**: moderate rather than severe, because the match is exact
(`security.ts:113-116`, with a good comment about prefix/suffix mistakes), so a wildcard entry
matches nothing and the system fails closed. But the operator gets "CORS and every WebSocket are
rejected" with no diagnostic, and the documentation told them the configuration was validated.
One real hazard: `safeRedirectTarget` uses `webOrigins[0]`
(`apps/api/src/auth/oidc.ts:326-328`), so a wildcard in first position would produce a broken
post-sign-in redirect.

**Fix**: reject a host containing `*` (and, while there, a trailing dot — `https://app.example.`
is currently accepted as a distinct origin) in `normaliseOrigin`, with a message naming the
wildcard.

**Missing test**: `normaliseOrigin` cases for `https://*.example`, `https://app.example.`,
`https://0x7f.1` (currently normalised to `https://127.0.0.1` — probably fine, worth an explicit
decision) and an IPv6 literal.

---

## P3 findings

### G16 — Broken documentation link

`README.md:237` links `docs/REPORT.md` — "Final delivery report: what was built, tested, and left
undone" — which does not exist. I checked every relative link in `README.md` and `docs/**/*.md`;
this is the only broken one.

```
BROKEN LINK README.md -> docs/REPORT.md
1 broken link(s)
```

**Fix**: write it or remove the row. **Missing test**: a link check in CI.

### G17 — The runbook sends the reader looking for a `TODO` that does not exist

`RUNBOOK.md:157-159`: "**Before any real deployment:** check `Dockerfile.api` and
`Dockerfile.web` for a `TODO` on the base-image digest. Where a digest could not be verified at
authoring time, the tag is used and marked."

Both Dockerfiles are digest-pinned
(`node:24.18.0-bookworm-slim@sha256:6f7b03f7…`), as is compose's
`postgres:16-bookworm@sha256:60f4761b…`, and neither contains a `TODO`. The instruction is stale
and undersells the work that was done.

**Fix**: replace with "base images are digest-pinned; refresh with the command in
`Dockerfile.api`'s header". **Missing test**: a check that every `FROM` and compose `image:`
carries an `@sha256:`.

### G18 — Agent instruction files ship inside the production web image

`.dockerignore:10` has `*.md`, but Docker ignore patterns are anchored to the context root, so
`apps/web/*.md` is not matched. `Dockerfile.api:121-123` and `Dockerfile.web:66-67` both assert
that `*.md` is kept out of the context.

```
$ docker run --rm --entrypoint sh prl-web-review:g -c 'find /app -name "*.md" -not -path "*/node_modules/*"'
/app/apps/web/CLAUDE.md
/app/apps/web/AGENTS.md
```

**Fix**: `**/*.md` (keeping an exception if any is needed at runtime). **Missing test**: an image
test asserting the shipped filesystem contains no `.md` outside `node_modules`.

### G19 — `packages/contracts` has no tests, and its test script cannot fail

`packages/contracts/package.json` declares `"test": "node --test 'test/**/*.test.ts'"`, and there
is no `test/` directory. `node --test` with no matching files exits 0, so the gate is inert:

```
packages/contracts test: ℹ tests 0
packages/contracts test: ℹ pass 0
packages/contracts test: ℹ fail 0
```

This matters more than usual because `@prl/contracts` is where G3's shared path constants should
live. **Fix**: add tests (schema round-trips, error-code exhaustiveness), or make the runner fail
on zero discovered tests. **Missing test**: a meta-check that every workspace package with a
`test` script discovers at least one test.

### G20 — `next dev` and `next build` share one `.next`, and the result is a silently broken production server

This is the current state of the shared web server on `:3000`. The browser console shows
`ChunkLoadError: Failed to load chunk /_next/static/chunks/1_jjh3ca-qmgp.js`, the network panel
shows that chunk returning **503**, the file is not on disk, and the client never hydrates — so
the boot overlay never clears and no count-up runs.

I reproduced the cause from clean:

```
$ rm -rf .next && next dev --port 3400   # one request, then stop
$ next build                             # into the SAME .next   -> exit 0, no warning
$ node -e "<cross-check referenced vs emitted chunks>"
on disk 29  referenced 58  MISSING 29
1rmo_next_dist_compiled_1qdyufb._.js, 1rmo_next_dist_shared_lib_0n40k7w._.js,
1rmo_next_dist_client_1xhl40-._.js, 1yi7_react-dom_1papa4l._.js, ...
```

Same check on this repo's `.next` (29 on disk, 47 referenced, 18 missing, including
`…next-devtools…` and `polyfill-nomodule`) versus a clean-room build (29 on disk, 29 referenced,
0 missing). So the repository's build is fine; the trap is the shared directory.

**Impact**: anyone who follows the documented dev flow and then builds for production in the same
checkout gets a server that returns 200 for every page and a client that is completely inert,
with no build-time error.

**Fix**: have `build` clean first (`node scripts/clean.mjs --next && next build`), or note in
RUNBOOK §3 that `pnpm run clean` is required between `dev` and `build`. **Missing test**: a
post-build check that every chunk referenced under `.next` exists on disk — it is ten lines and
it catches this class permanently.

### G21 — The boot overlay depends solely on `requestAnimationFrame`

`apps/web/src/components/BootSequence.tsx:112-118`. The component documents four exits (reduced
motion, repeat visit, a 900 ms cap, no scripting) and they are all real, but the 900 ms cap is
measured *inside* the rAF loop. In a hidden tab rAF does not fire, so nothing advances and the
overlay — `position: fixed`, full viewport, `z-index: 900`, `pointer-events: auto` — stays up
indefinitely.

```
$ // in the page, clean production build
{ visibility: "hidden", hasFocus: false, rafFires: "NO - throttled",
  overlay: [{ tag: "DIV", cls: "prl-boot", pe: "auto", op: "1", z: "900" }] }
```

Page text confirms the whole document is server-rendered underneath and readable; only the
overlay is stuck. For a human this self-heals the moment the tab is foregrounded, which is why
this is P3 and not higher. But it makes automated end-to-end testing of the app impossible
without a foregrounded tab, and it is a hazard for any prerender or occluded-window case.

**Fix**: add a `setTimeout(…, remaining)` alongside the rAF loop as the authoritative cap (the
comment's own "900ms end to end no matter what" then becomes true), or dismiss on
`visibilitychange` when hidden. **Missing test**: a test that mounts the component with rAF
stubbed to never fire and asserts the overlay is removed by the deadline.

### G22 — A routine CSRF rejection logs a full stack trace with absolute paths

A plain `POST` without a token produces, at `warn`:

```
{"level":40,"reqId":"90baf5bb-…","err":{"type":"FastifyError","message":"Missing csrf secret",
 "stack":"FastifyError: Missing csrf secret\n    at Object.csrfProtection (/Users/terence/Projects/
 exploration-sites/poker-risk-lab/node_modules/.pnpm/@fastify+csrf-protection@8.0.1/… )\n    at …",
 "code":"FST_CSRF_MISSING_SECRET"},"apiErrorCode":"csrf_failed","frameworkStatus":403,…}
```

An expected client-side condition should not cost a stack trace, and the trace discloses install
paths. The response body is correctly minimal (`code`, generic message, `requestId`).

**Fix**: log expected 4xx conditions at `info`/`warn` with the code only, and reserve `err` (with
stack) for 5xx. **Missing test**: a logging test asserting no `err.stack` field is emitted for a
`csrf_failed` / `invalid_request` rejection.

---

## What passed

Recorded because a review that only lists faults is not a review.

**Install.** `pnpm install --frozen-lockfile` succeeds from a clean checkout in 3 s with the
committed lockfile, 104 packages, no lifecycle scripts.

**Configuration.** Excellent. Every problem is reported at once, and the process exits 78
(`EX_CONFIG`) rather than starting half-configured:

```
$ env -i NODE_ENV=production node src/server.ts
Refusing to start: 3 configuration problems.
  - PUBLIC_WEB_ORIGIN is required in production (comma-separated allowlist)
  - SESSION_COOKIE_SECRET is required in production; generate one with `node -e "..."`
  - DATABASE_URL is required but missing or empty

$ # eight simultaneous problems, all reported together
Refusing to start: 8 configuration problems.
  - PUBLIC_WEB_ORIGIN entry "http://app.example" is plaintext http; ...
  - SESSION_COOKIE_SECRET looks like a placeholder (it contains "example"); ...
  - COOKIE_SECURE=false is not allowed in production: ...
  - TRUST_PROXY must be true or false, got "maybe"
  - PORT must be an integer, got "8080abc"
  - DATABASE_URL must be a postgres:// or postgresql:// URL
  - RATE_LIMIT_MAX must be between 1 and 100000, got -5
  - OIDC is partially configured: OIDC_ISSUER set but OIDC_CLIENT_ID, OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URI missing. Set all four or none.
EXIT=78
```

The example secret shipped in `.env.example` is genuinely refused in production. Weak-secret,
`COOKIE_SECURE=false`, plaintext-origin and partial-OIDC refusals all work. It does not start
with a half-valid config.

**Database.** Everything the runbook claims about migrations is true.

- Applies cleanly to an empty database: `0001` 48 ms, `0002` 23 ms.
- Idempotent on a second run: `✓ up to date — 2 migration(s) applied, nothing pending`.
- Seeds are idempotent (19 ms, then 5 ms).
- An edited migration aborts and applies nothing:
  `CHANGED 0002… ledger 0283c0c4a0da != file 89f8a7a24ed6` → `up` exits 1 with
  "Nothing has been applied."
- The advisory lock genuinely serialises: with the lock held by another session,
  `up` retried for 3 s then failed with "Another migration is already running", exit 1.
- `seed` and `reset` both refuse under `NODE_ENV=production`, checked twice (before connecting
  and inside the command), exit 1.
- `reset` waits for the lock, drops the schema, reapplies, exit 0.
- An unknown command is refused rather than falling through to `reset`.
- `pnpm run db:verify` passes: "121 columns … 41 indexes … checked 13 tables for prl_app
  privileges … every documented schema security property holds".
- `prl_app`'s privileges are exactly as documented (see G11 for the transcript).

**Web build.** `next build` succeeds in 4.3 s with no warnings, needs no network, and does not
need `sharp` (`images.unoptimized: true`, honestly explained in `next.config.ts`). Thirteen
routes, 11 prerendered.

**Startup and probes.** `GET /api/v1/health` answers from memory and is rate-limit exempt.
`GET /api/v1/ready` really queries the database — pointed at a dead one it returns **503** with a
non-leaking reason, while health stays 200:

```
health: {"status":"ok","version":"0.1.0","protocolVersion":1}                 200
ready:  {"status":"degraded","checks":{"database":{"ok":false,"detail":"database did not answer"}}}  503
```

**Shutdown, in the two cases that work.** No pool use: 6 ms, exit 0. Pool used and finished:
25 ms, exit 0. `SIGTERM` and `SIGINT` are both handled, a second signal is ignored, and the
in-flight response is delivered even in the failing case.

**Observability.** Logs are single-line JSON with a `reqId` on every line, and the redaction is
real rather than declared. I sent a request carrying a session cookie, a bearer token, an API key
and a display name:

```
not present: SUPERSECRETSESSIONVALUE123
not present: TOKENSHOULDNOTAPPEAR456
not present: APIKEYSHOULDNOTAPPEAR789
not present: SECRETDISPLAYNAME999
```

No raw IP is logged anywhere; the only client identifier is a keyed hash
(`"clientKey":"8bb48d340fd21273"`).

**Container hardening (static, plus the web image at runtime).** Both Dockerfiles pin the base by
digest, run as `USER node` (uid 1000), ship no package manager in the runtime stage, and use
`node -e` healthchecks with no shell. `.dockerignore` excludes `.env` and `.env.*` — I confirmed
no `.env*` file exists inside the built web image. Compose sets `read_only: true`,
`cap_drop: ALL`, `no-new-privileges`, `init: true`, loopback-only port publishing, and a
`pg_isready` healthcheck against the real user and database. With the `WORKDIR` corrected, the
web container runs healthy under a read-only root filesystem with only the two documented tmpfs
mounts.

**Tests and quality.** `pnpm run test` 414 tests, 414 pass, 0 fail, **0 skipped, 0 todo**, 29 s.
`pnpm run test:exhaustive` 7.2 s, both tests pass ("all 133,784,560 seven-card hands classify to
the published frequencies"). `pnpm run lint` exits 0 with 2 cognitive-complexity warnings.
`pnpm run test:smoke` 37 checks passed. `pnpm run test:a11y` 6 routes, 0 violations.
`node scripts/check-contrast.mjs` PASS on both the token and rendered layers.

**Seven of the eight supply-chain gates** pass in a clean room: hygiene (339 files), deny-list
(162 resolved / 104 installed), dependency shapes, IOC sweep (10 434 files, 122.6 MiB),
integrity + release age (162 versions queried, provenance recorded but explicitly not trusted),
OSV (0 advisories), SBOM (170 components).

**The eight previously-found defects.** All eight fixes hold as far as I exercised them: `pnpm
run` works (subject to G2, which is a different mechanism); `pnpm test` does not pull in the
exhaustive suite; `.env.example`'s DB password matches compose (`poker-dev-only`, verified by a
successful connection); port 3001 is consistent across `.env.example`, compose, config default
and the web client default (the one stale `8080` is G14); `GET /api/v1/hands` returns 200 via the
smoke test; hands persist (the smoke test reads hand history); guest-creation rate limiting fires
("429 after repeated attempts"); the impersonation guard is covered by other agents.

---

## What I could not verify

1. **The API container's runtime properties** — non-root, read-only root filesystem, healthcheck,
   pruned contents. The image cannot be built (G1), so my assessment of `Dockerfile.api` is a
   static read only.
2. **`docker compose up --build api web` end to end**, for the same reason. I verified each
   failure separately (`docker compose build api` → exit 1; `docker compose up -d --no-deps web`
   → `Restarting (1)`).
3. **`pnpm install --frozen-lockfile` in this repository.** Deliberately not run: it would very
   likely remove the six hand-made symlinks the working copy depends on (G1) and leave the shared
   review environment unable to build. All install evidence comes from clean-room copies.
4. **A full hand played through the browser** — impossible, because `/play` is a fixture (G6). I
   exercised the equivalent journey through the API instead (`test:smoke`, 37 checks) and
   attempted it through the WebSocket harness (blocked by G10).
5. **The OIDC sign-in flow.** No provider is configured and the guardrails forbid me creating
   accounts or entering credentials. I verified only the all-or-nothing config validation.
6. **`prl_app` in real use.** Nothing in the repo connects as it (G11); I verified its privileges
   by creating a temporary login role, then dropped it.
7. **GitHub Actions actually running.** I read the workflows and reproduced every command they
   run locally. My claim that CI is red rests on `pnpm run security:audit` exiting 1 in two
   independent trees plus the `needs: supply-chain` dependency graph, not on an observed run.
8. **TLS, a real proxy, or any production topology.** No such environment here.
9. **Whether `next dev`'s 500 (G8) reproduces on Linux/CI.** All six runs were on darwin/arm64.

---

## Every command I ran

Clean-room (`$CR` = scratchpad copy of the repo, no `node_modules`, no `.env`):

| Command | Outcome |
|---|---|
| `pnpm install --frozen-lockfile` | ok, 3 s, 104 packages |
| `pnpm run build:packages` | ok, 1.9 s, 6 packages |
| `pnpm run build` | **FAIL** exit 2 (G1) |
| `pnpm run typecheck` | **FAIL** exit 1 (G1) |
| `pnpm run lint` | ok, exit 0, 2 warnings |
| `pnpm run test` | ok, 414/414, 0 skipped |
| `pnpm run test:exhaustive` | ok, 7.2 s |
| `pnpm run security:audit` | **FAIL** exit 1, 1 of 8 gates (G2) |
| `pnpm run security:policy` | **FAIL** exit 1 (G2) |
| `node scripts/supply-chain/policy-check.mjs` | ok, exit 0 — proves G2's mechanism |
| `pnpm install --no-frozen-lockfile` | ok, zero lockfile diff |
| `next build` (apps/web) | ok, 4.3 s, 13 routes |
| `next dev` × 6, `rm -rf .next` each | 4 × HTTP 500, 2 × HTTP 200 (G8) |
| `next dev` then `next build` then chunk cross-check | 29 dangling references (G20) |

This repository / live environment:

| Command | Outcome |
|---|---|
| `curl /api/v1/health`, `/api/v1/ready`, `curl :3000/` | 200 / ready / 200 |
| `pnpm run security:policy` | **FAIL** exit 1 (G2) |
| `pnpm run db:verify` | ok, all properties hold |
| `pnpm run test:smoke` | ok, 37 checks |
| `pnpm run test:a11y -- --no-start …` | ok, 6 routes, 0 violations |
| `node scripts/check-contrast.mjs` | ok, PASS both layers |
| `node scripts/load-test.mjs …` | **FAIL** exit 1, 100 % errors (G10) |
| `apps/api: tsc -p tsconfig.json` | ok — only because of the hand-made symlinks (G1) |
| `docker build -f Dockerfile.api .` | **FAIL** exit 1 (G1) |
| `docker build -f Dockerfile.web .` | ok, 51 s |
| `docker run prl-web-review:g` | **FAIL** exit 1 (G4) |
| `docker run -w /app/apps/web --read-only …` | ok, healthy, 200 on `/` and `/learn` |
| `docker compose build api` | **FAIL** exit 1 (G1) |
| `docker compose up -d --no-deps web` | **FAIL** `Restarting (1)` (G4) |
| `docker compose config` | rendered; used as G5 evidence |

Fresh database `prl_review_g` (created and dropped by me; the shared `poker_risk_lab` was not
touched):

| Command | Outcome |
|---|---|
| `migrate.mjs status` (empty db) | 2 pending, 0 applied |
| `migrate.mjs up` | ok, 0001 48 ms, 0002 23 ms |
| `migrate.mjs up` (again) | ok, "up to date" |
| `migrate.mjs seed` ×2 | ok, idempotent |
| `migrate.mjs up` with an edited 0002 | **aborts**, exit 1, nothing applied |
| `migrate.mjs up` with the lock held elsewhere | **aborts** after retrying, exit 1 |
| `NODE_ENV=production migrate.mjs seed` / `reset` | **refused**, exit 1 |
| `migrate.mjs nuke` | refused, exit 1 |
| `migrate.mjs reset` (dev) | ok, dropped and reapplied |
| `psql` as a member of `prl_app`: create/truncate/drop/alter/delete/create-schema | all refused |

Servers I started for testing (ports 3055–3082, 3101, 3200, 3300, 3400–3439) and the containers,
images, database and role I created were all removed. Verified after cleanup: API `:3001`
healthy, web `:3000` returns 200, `poker-risk-lab-postgres-1` up and healthy, no stray review
processes.
