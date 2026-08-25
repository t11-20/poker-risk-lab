# The staging stack

A production-shaped rehearsal of Poker Risk Lab on one machine, running **the exact
image digests that would go to production**.

`docker-compose.yml` at the repository root is a developer's laptop and says so in
its own header: plaintext on loopback, `NODE_ENV=development`, dev credentials in
plain sight, and `build:` sections that produce a new image every time somebody
types `up --build`. Every production-only behaviour was therefore first exercised
in production, by users:

- the `Secure`, `__Host-`-prefixed session cookie, which a browser will not send
  over plain HTTP at all;
- the eight refusals in `apps/api/src/config.ts` that only fire when
  `NODE_ENV=production`;
- TLS termination, and what a reverse proxy does to `Origin`, `Host` and
  `X-Forwarded-*`;
- `TRUST_PROXY=true`, and the rate-limit bucketing that depends on it;
- the WebSocket upgrade through a real proxy rather than through `next dev`.

This directory is the rehearsal. On its first real run it found two defects that
no test in the repository could have found; they are listed at the end.

---

## The first run, exactly

```bash
pnpm run staging init        # local CA, leaf certificate, generated secrets
pnpm run release:artifacts   # build BOTH images ONCE, record their digests
pnpm run staging up          # deploy those digests, migrate, verify, smoke
```

Then:

```bash
pnpm run staging status      # what is running, and whether it matches the manifest
pnpm run staging smoke       # re-run the smoke test against the running stack
pnpm run staging logs --service api --tail 200
pnpm run staging promote     # verify a digest is the one staging tested
pnpm run staging down        # stop (add --volumes to destroy the database too)
```

The browser-facing origin is **https://localhost:8443**. Your browser will warn
about the certificate: it is issued by a CA created on your machine by
`staging init` and trusted by nothing else. Import `tls/staging-ca.pem` into your
trust store if you want a clean padlock; the smoke test already verifies the chain
properly, through `NODE_EXTRA_CA_CERTS`, so nothing in the automated path skips
verification.

The development stack can run at the same time. Staging publishes 8443 and 55432;
the development stack publishes 3000 and 5432, and the two compose projects have
different names.

---

## Build once, promote the same digest

This is the whole architecture, and it is the reason the two scripts exist.

```
  release-artifacts.mjs          staging.mjs up                staging.mjs promote
  ─────────────────────          ──────────────                ───────────────────
  docker build  x2               reads the manifest            reads the manifest
       │                              │                             │
       ▼                              ▼                             ▼
  release-manifest.json ───────▶ deploys BY DIGEST ────▶ staging-verified.json
   (api + web digests)           verifies what is                   │
                                 actually running                   ▼
                                                          refuses anything that
                                                          is not that digest
```

- `release-artifacts.mjs` is the **only** place an image is built. It builds each
  Dockerfile once, records the digest BuildKit assigned, and refuses to rebuild a
  commit whose manifest is still valid unless you pass `--force`.
- `docker-compose.staging.yml` has **no `build:` section anywhere** and names both
  application images by digest, injected from the manifest.
- After `up`, `staging.mjs` reads `docker inspect` on the running containers and
  fails if their image is not the manifest's digest. Deploying "a build like the
  one we tested" is not possible here; either it is the same bytes or the command
  fails.
- `promote` compares the manifest against the attestation `up` wrote, and prints
  **both digests** on a mismatch.

`staging-verified.json` is written only when every check AND the strict smoke test
passed. Its absence is a refusal, not a warning: nothing has earned a promotion.

### What "digest" means here, precisely

There is no container registry in this project and nothing is pushed. The digest
is the one BuildKit's exporter assigns in the local containerd image store — the
value `--iidfile` writes, the value `docker image inspect --format '{{.Id}}'`
reports, and the value that appears in `RepoDigests`. It is content-addressed:
two builds producing different bytes cannot share it.

It is **not** registry-attested. Nobody signed it and no registry vouches for it,
and it exists only on the machine that built it. `promote` says so in its own
output rather than implying more. When this project gains a registry, the push
step records the registry digest alongside this one and promotion compares that.

---

## What is in the stack, and the decisions inside it

| Service | Image | Published | Notes |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-bookworm`, by digest | `127.0.0.1:55432` | Same digest as CI and the dev stack. Runs as uid 999, read-only root. |
| `api` | the release digest | nothing | `NODE_ENV=production`, `TRUST_PROXY=true`, one replica. |
| `web` | the release digest | nothing | `NODE_ENV=production`, `PRL_API_ORIGIN=http://api:3001`. |
| `proxy` | `nginxinc/nginx-unprivileged`, by digest | `127.0.0.1:8443` | TLS terminates here. The only published origin. |

Every container: non-root, `read_only: true` with explicit tmpfs mounts,
`cap_drop: ALL`, `no-new-privileges`, `init: true`. No source bind mounts, and
nothing installs a dependency at runtime. The only mounts are the proxy's
read-only configuration and its read-only certificate directory.

### Why nginx and not Caddy

Caddy's `tls internal` would mint the leaf itself and nothing would have to be
generated on the host, which is genuinely nicer. It cannot be used here, and the
reason is measured rather than aesthetic: the `caddy` binary carries the file
capability `cap_net_bind_service=ep`, and Linux refuses `execve` of a file whose
permitted capability set is not inside the process's bounding set. Under
`cap_drop: ALL` the container cannot start at all:

```
$ docker run --cap-drop ALL --user 1000:1000 caddy:2.11.4-alpine caddy version
sh: caddy: Operation not permitted
```

The ways round that are handing back `NET_BIND_SERVICE` to a proxy that listens on
8443 and does not need it, or dropping `cap_drop: ALL`. Neither is worth trading
for certificate convenience when `nginxinc/nginx-unprivileged` runs as uid 101,
binds a high port, and carries no file capabilities at all — and when the
development stack already uses it, so staging and development are the same proxy
with the same routing semantics. `docs/RUNBOOK.md` §11.2 tells a deployer to
"lift its nginx config"; `nginx.conf` here is that config, lifted and given TLS.

### HTTPS only, no plaintext redirect

The usual shape is port 80 answering with a 308. There is none here, and that is
stronger rather than lazier: a redirect means the staging origin answers on http,
which is an origin somebody bookmarks, a link somebody pastes, and a first request
that carried a cookie in the clear before the redirect was read. Connection
refused is unambiguous. A production edge in front of a real domain does want the
redirect, and it belongs there — at the edge that owns the public DNS name.

### `X-Forwarded-For` is SET, never appended, and that is proven

The API runs with `TRUST_PROXY=true`, so Fastify takes `request.ip` from the
leftmost `X-Forwarded-For` value. Guest creation is rate limited on that address
(ten per minute) because the endpoint hands out a fresh session cookie and a
session-keyed limit would never accumulate.

So if the proxy used `$proxy_add_x_forwarded_for` — the spelling most nginx
configurations on the internet use — a client could send its own
`X-Forwarded-For`, land in a fresh bucket on every request, and create guests
without limit. The config uses `$remote_addr`, and `staging up` proves it rather
than trusting the comment: it sends 24 guest creations with 24 different forged
client addresses and asserts that they were rate limited. Measured on
2026-08-22: **24/24 refused**, so the forged header chose nothing.

With `TRUST_PROXY=false` behind this proxy the failure is the mirror image and
just as bad: `request.ip` becomes the proxy's address for every browser in the
world, the whole deployment shares ten guest sign-ups a minute, and one script
exhausts it for everybody — a self-inflicted denial of service that looks, in the
logs, exactly like the limiter working.

### `RATE_LIMIT_RESET_TOKEN` is absent, deliberately

`NODE_ENV=production` here, and `config.ts` **refuses to boot** when that token is
set in production: it empties the rate limiter, which for its holder is equivalent
to turning rate limiting off. Staging is a production environment for that
purpose. The cost is that the smoke test waits out the rate-limit window instead
of resetting it. That is slower and it is honest.

---

## Secrets and certificates

Nothing here is committed and nothing is baked into an image.

| Path | Contents | Kept out of git by | Kept out of images by |
| --- | --- | --- | --- |
| `.env.staging` | session secret, database passwords, metrics token, image digests | `.gitignore` here | `.dockerignore` excludes `deploy` |
| `tls/` | local CA, its key, the leaf and its key | `.gitignore` here | `.dockerignore` excludes `deploy` |
| `release-manifest.json` | which digests this machine built | `.gitignore` here | as above |
| `staging-verified.json` | which digests a verified run attested to | `.gitignore` here | as above |

`staging init` generates each secret once and leaves an existing one alone;
`--rotate` replaces them. They are **hex**, not base64url, and that is not
cosmetic: `config.ts` rejects any secret containing `change`, `example`,
`placeholder`, `insecure`, `password`, `secret`, `default`, `todo`, `xxxx`, `test`
or `dev-only`, and the hex alphabet cannot spell any of those — every one needs a
letter outside `a-f`. A random base64url string can be rejected as a placeholder,
rarely, and only on somebody else's machine.

The leaf key is `chmod 0644`. That deserves a sentence rather than a shrug: nginx
runs as uid 101 inside the container and reads the key through a bind mount, and
on Linux a 0600 file owned by the host user is unreadable to it. This is a
throwaway certificate for a loopback origin, regenerated by `staging init`, in a
directory git will not accept. **A real deployment injects its key through the
platform's secret mechanism and never through a bind mount**; that is the shape to
copy, not this one.

Every variable in `docker-compose.staging.yml` is required and none has a default,
so **every** compose command against it needs the environment file:

```bash
docker compose --env-file deploy/staging/.env.staging -f docker-compose.staging.yml ps
```

`scripts/staging.mjs` passes it to every invocation it makes, `down` and `logs`
included. Compose interpolation is file-wide rather than service-scoped — that is
the trap that made `pnpm run db:up` fail with "required variable
SESSION_COOKIE_SECRET is missing" even though postgres never read it — and here it
is embraced rather than worked around, because there is no subset of a deployment
manifest that is meaningful without its secrets.

---

## The database

Migrations run from **outside** the serving container, which is a decision rather
than a convenience: `Dockerfile.api` deliberately omits `apps/api/scripts`, so the
image that serves traffic cannot change the schema (`docs/RUNBOOK.md` §11.3).
`staging up` therefore does it from the checkout, in this order:

1. `migrate.mjs roles` — creates the cluster-wide `prl_migrator` and `prl_app`
   privilege containers.
2. `migrate.mjs up` — applies the migrations.
3. SQL through `psql` inside the postgres container — creates the **runtime login
   identity** `prl_api` with a generated password, grants it `prl_app`, and then
   asserts that it has `USAGE` on schema `prl` and does **not** have `CREATE`. A
   role that could still create objects would make the least-privilege model
   theatre.

The development seed that creates `prl_api` with a known password refuses to run
when `NODE_ENV=production`, which is exactly right, and is why staging does this
in SQL with a generated value instead.

**What staging does not rehearse:** migrations here run as the cluster owner, the
way `.github/workflows/ci.yml` does, because this stack creates its own throwaway
cluster on every bring-up. A real deployment migrates as a dedicated `prl_deployer`
identity (`docs/RUNBOOK.md` §5, §11.3). The *runtime* identity **is** rehearsed,
and that is the one whose missing GRANT would otherwise surface in production.

---

## What `staging up` actually verifies

Not "it started". In order:

1. the manifest's references are content digests, or it refuses;
2. postgres is healthy, migrations applied, the runtime identity created and
   proven bounded;
3. every service is running and healthy — the API's healthcheck requires **both**
   `/api/v1/health` and `/api/v1/ready`, so `depends_on: service_healthy` means
   "can actually serve" rather than "a process exists";
4. the **running containers carry the manifest's digests**, read from
   `docker inspect`;
5. `https://localhost:8443/api/v1/ready` answers 200, with the chain **verified**
   against the local CA rather than waved through;
6. the proxy is the **only** source of `Strict-Transport-Security` — probed on a
   path the API does not serve, and asserted to be exactly one header with the
   value `nginx.conf` sets. This check used to probe `/api/v1/health` and tick as
   long as *a* header came back, which is why it never noticed that the API also
   sends one (helmet, whenever `NODE_ENV=production`, which staging is) and that
   `add_header` appends rather than replaces: every `/api/*` response carried two,
   and a browser obeys only the first. `proxy_hide_header` in `nginx.conf` now
   drops the upstream's copy;
7. the smoke test, `--strict`, over https: guest sessions, CSRF enforcement,
   content, calculation, rooms, the hidden-information property over a **real
   `wss://` WebSocket**, hand-history isolation, the CSP on the rendered page, and
   rate limiting;
8. the `X-Forwarded-For` overwrite proof described above.

## Alerting, as an overlay

`docker-compose.observability.yml` adds a Prometheus and an Alertmanager beside this
stack, and `pnpm run alerts:verify` uses them to answer a question staging could not
answer before: do the twenty-two rules in `docs/production/alerts.md` load, agree with
that document, name series that exist, evaluate, and — for one of them, provoked for
real — fire, route by severity and arrive at a receiver.

```bash
pnpm run staging up          # this stack first; the overlay scrapes it
pnpm run alerts:verify       # ~5 minutes; STOPS the API for about two of them
pnpm run alerts:verify -- --skip-provoke   # ~30s, checks 1-4 only, API untouched
```

It is an overlay and not part of `docker-compose.staging.yml` for the same reason that
file has no `build:` section: that file is a manifest of what production runs, and
production does not get its monitoring from this repository. `pnpm run staging up` brings
up no Prometheus, and nothing here depends on one existing.

Two things to know before running it:

- **It stops the API container.** `ApiDown` has `for: 2m` on top of a two-minute
  `max_over_time` window, so the earliest it can fire is a little over four minutes after
  the container stops. The script restores the API in a `finally` block, so an interrupted
  run does not leave staging down — but a `kill -9` of the script will.
- **It writes `observability/metrics-token`**, the bearer token Prometheus scrapes with,
  because compose interpolates compose files and not the files they mount. It is
  gitignored, `scripts/supply-chain/secret-scan.mjs` asserts that rule, and the script
  deletes it on the way out unless `--keep-up` was passed.

Both receivers are a webhook sink the script runs on this host. Production replaces two
URLs in `observability/alertmanager.yml`; nothing between here and there is rehearsed.

---

## What it does not prove

- **Capacity, of anything.** One replica on one machine with the database on the
  same kernel is not a load test. `scripts/load-test.mjs` says the same about
  itself.
- **A second API replica.** There must not be one: `rooms/registry.ts` keeps
  authoritative hand state in process memory, so two processes serving one room
  deal two different hands and nothing detects it (ADR 0001, RUNBOOK §11.1).
  `deploy: replicas: 1` is a correctness constraint.
- **A deploy identity, a registry, or a rollback.** See
  `.github/workflows/release.yml`, which is explicit about which of its steps
  cannot execute today and fails rather than pretending.

---

## What the first real run found

Both of these are application defects outside this directory, and neither could
have been found by the test suite or by the development stack. They are recorded
here because they are the argument for the stack existing.

**1. Monte Carlo equity throws in production, so bots never act.**
`packages/poker-math/src/equity.ts` calls
`createDeterministicRandomForTests(seed)`, and that function throws when
`NODE_ENV === 'production'` by design (`packages/poker-engine/src/rng.ts`). The
API log shows `a bot policy failed to decide` with
`RandomnessError: createDeterministicRandomForTests must never be used in production`,
the bot never acts, and the hand hangs. Reproduced directly:

```
$ NODE_ENV=production node -e "…monteCarloEquity(…)"
THREW: RandomnessError - createDeterministicRandomForTests must never be used in production
```

The exact-enumeration path is unaffected, which is why the smoke test's equity
check passes and the live hand does not.

**2. Guest bootstrap is refused behind any proxy whose public origin differs from
the container's own address.** `apps/web/src/proxy.ts` mints the guest with
`origin: request.nextUrl.origin`, and inside the container that resolves to the
server's own listening address rather than the public one. Measured by pointing
the web image at an echo server: with `Host: localhost:8443` and
`X-Forwarded-Proto: https` and `X-Forwarded-Host: localhost:8443`, the API
received `origin: https://localhost:3000`. The API correctly answers 403
`cross-origin POST from an origin that is not allowlisted`, and the reader gets no
session.

This works on the development stack only by coincidence: there the proxy publishes
port 3000 and web listens on 3000, so the two spellings happen to match. It cannot
be fixed at the proxy — no forwarded header changed the answer — and it cannot be
worked around by allowlisting the wrong origin, because `PUBLIC_WEB_ORIGIN`
refuses a plaintext entry in production and the port would still be wrong.
