# The staging environment

A production-shaped rehearsal of Poker Risk Lab on one machine, running **the exact image digests that would go to production**.

This document is the operator's view: what staging is for, how to stand it up, which production behaviours it genuinely reproduces, which it deliberately does not, and what a real run of it found. The implementation notes — why nginx rather than Caddy, why the leaf key is `0644`, why every compose variable is required — are in [`deploy/staging/README.md`](../../deploy/staging/README.md) and in the headers of `docker-compose.staging.yml` and `deploy/staging/nginx.conf`. They are not repeated here.

Architecture context is [`architecture.md`](architecture.md) §1, §2, §5 and §7. The pipeline this environment sits inside is [`deployment.md`](deployment.md).

---

## 1. Why this exists

There was no way to run this application the way it ships.

`docker-compose.yml` at the repository root is a developer's laptop and says so in its own header: plaintext on loopback, `NODE_ENV=development`, development credentials in plain sight, and `build:` sections that produce a new image every time somebody types `up --build`. Every production-only behaviour was therefore first exercised in production, by users:

- the `Secure`, `__Host-`-prefixed session cookie, which a browser will not send over plain HTTP at all;
- the refusals in `apps/api/src/config.ts` that only fire when `NODE_ENV=production`;
- TLS termination, and what a reverse proxy does to `Origin`, `Host` and `X-Forwarded-*`;
- `TRUST_PROXY=true`, and the rate-limit bucketing that depends on it;
- the WebSocket upgrade through a real proxy rather than through `next dev`.

The argument for the whole apparatus is §8: on its first real run, this stack found two defects that no test in the repository could have found, across several prior audits that had all passed.

---

## 2. Standing it up

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
pnpm run staging down        # add --volumes to destroy the database too
```

The browser-facing origin is **`https://localhost:8443`**. The browser will warn about the certificate: it is issued by a CA created on the machine by `staging init` and trusted by nothing else. Import `deploy/staging/tls/staging-ca.pem` into a trust store for a clean padlock; the automated path never skips verification — the smoke test runs with `NODE_EXTRA_CA_CERTS` pointing at that CA, and `staging.mjs`'s own probes pass the CA explicitly to `node:https`.

The development stack can run at the same time. Staging publishes `127.0.0.1:8443` and `127.0.0.1:55432`; the development stack publishes 3000 and 5432, and the two compose projects have different names (`poker-risk-lab-staging`).

### What each command does

| Command | Effect | Exit |
| --- | --- | --- |
| `init` | generates `deploy/staging/tls/` (CA, leaf, chain, keys) and `deploy/staging/.env.staging` at mode 0600. Existing secrets are left alone unless `--rotate`. `--origin <url>` sets the public origin and the published port together | 0 / 1 |
| `up` | writes the manifest digests into the environment file, starts postgres, migrates, creates and bounds the runtime role, starts the stack, then runs the eight verifications in §6 | 0 / 1 |
| `status` | per-service state and health, the running image digest, whether each matches the manifest, and whether an attestation exists. Exits 1 if a running container does **not** match | 0 / 1 |
| `smoke` | `scripts/smoke-test.mjs --strict` against the staging origin, over TLS | 0 / 1 |
| `logs` | `docker compose logs`, with `--env-file` attached so it works at all | 0 |
| `down` | stops the stack. `--volumes` destroys the database volume. On success it **removes `staging-verified.json`** — the attestation described a stack that no longer exists, and leaving it would let `promote` vouch for something nobody can look at any more | 0 / 1 |
| `promote` | compares the manifest against the attestation and refuses a mismatch. Does **not** deploy | 0 / 1 |

### Certificates expire on purpose

The CA and its leaf are valid for 90 days, not ten years. `up` warns below 14 days remaining and refuses outright once expired (`the staging certificate expired N day(s) ago`). A staging certificate that never expires is a staging certificate somebody eventually copies somewhere it matters; an expiry is the cheapest way to make `staging init` a thing that gets re-run.

### Raw compose commands need the environment file

Every variable in `docker-compose.staging.yml` is required and none has a default, and compose interpolation is file-wide rather than service-scoped. So:

```bash
docker compose --env-file deploy/staging/.env.staging -f docker-compose.staging.yml ps
```

`scripts/staging.mjs` attaches that flag to every compose invocation it makes, `down` and `logs` included. Without it, even `ps` fails with `required variable PRL_API_IMAGE is missing`.

---

## 3. What is in the stack

| Service | Image | Published | Runs as |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-bookworm`, by digest | `127.0.0.1:55432` | uid 999 |
| `api` | the release digest | nothing | uid 1000 (`node`) |
| `web` | the release digest | nothing | uid 1000 (`node`) |
| `proxy` | `nginxinc/nginx-unprivileged:1.29.8-alpine`, by digest | `127.0.0.1:8443` | uid 101 |

Every container: `read_only: true` with explicit tmpfs mounts, `cap_drop: ALL`, `no-new-privileges:true`, `init: true`. The only bind mounts are the proxy's read-only configuration file and its read-only certificate directory. Nothing mounts a source tree and nothing installs a dependency at start.

`deploy: replicas: 1` on the API is a **correctness constraint**, not a sizing choice: `apps/api/src/rooms/registry.ts` keeps authoritative hand state in process memory, so two processes serving one room deal two different hands and nothing detects it (ADR 0001, `docs/RUNBOOK.md` §11.1). Staging runs one replica because production must, and nothing here tests a second one because there must not be a second one.

---

## 4. Production-equivalence, item by item

The column that matters is the last one. "Rehearsed" means a running deployment exercised it; "shape only" means staging does the same *kind* of thing production will, without proving production's version of it.

| Property | In staging | In production | Rehearsed? |
| --- | --- | --- | --- |
| Immutable OCI images, deployed **by digest** | `image: prl-api@sha256:…` from the release manifest; no `build:` anywhere in the file; `staging.mjs` re-reads `docker inspect` after `up` and fails if the running container is not that digest | same digest, pulled from a registry that vouches for it | **yes** — both containers matched the manifest on 2026-08-22 |
| PostgreSQL at a production-compatible version, pinned by digest | `postgres:16-bookworm@sha256:60f4761b…`, the same digest CI and the development stack use | the same major version, ideally the same digest | **yes** |
| TLS termination | nginx, TLS 1.2 floor, HTTP/2, session tickets off, chain from a locally generated CA | a real certificate from a real CA at the platform edge | shape only — the *chain verification* is real, the *issuer* is local |
| Reverse proxy, one published origin | `deploy/staging/nginx.conf`, routing `/api/`, `/ws` and `/` | the same file, with `resolver 127.0.0.11` replaced by the platform's DNS | **yes** |
| WebSocket upgrade for `/api/v1/ws` | `map $http_upgrade $connection_upgrade`, `proxy_read_timeout 3600s` | same | **yes** — the smoke test plays a hand over a real `wss://` socket |
| Production CSP | minted per response, with a nonce, by `apps/web/src/proxy.ts`; the proxy does **not** set or overwrite it | same | **yes** — the smoke test asserts the CSP on the rendered page |
| Production cookies | `NODE_ENV=production`, so `Secure` and the `__Host-` prefix are on; `COOKIE_SECURE=false` is refused at boot | same | **yes** |
| CORS and origin rules | `PUBLIC_WEB_ORIGIN=https://localhost:8443`, matched exactly on CSRF and on every socket upgrade; `Origin` passed through untouched | the real public origin | **yes** |
| Secrets injected externally | generated by `staging init` into `.env.staging` (gitignored, dockerignored, mode 0600) and supplied via `--env-file`; nothing is baked into an image | a secret manager, same variable names, different source | shape only |
| **No** source bind mounts | none — only the proxy's config and TLS material, both `:ro` | none | **yes** |
| **No** dependency installation at runtime | the images ship their `node_modules`; `npm` and `corepack` are deleted from both runtime images | same | **yes** |
| Non-root containers | uids 999 / 1000 / 1000 / 101; `release-artifacts.mjs` fails the build if `Config.User` is not `node` | same | **yes** |
| Health and readiness probes | the API healthcheck requires **both** `/api/v1/health` and `/api/v1/ready`, so `depends_on: service_healthy` means "can actually serve" | `/api/v1/ready` is the one a load balancer uses (`docs/RUNBOOK.md` §11.6) | **yes** |
| Migrations from outside the serving container | run from the checkout against the published database port, before the API starts | a one-shot job at the release commit, as `prl_deployer` | shape only — see §7 |

`docs/RUNBOOK.md` §11.2 tells a deployer to "lift its nginx config" from the development compose file. `deploy/staging/nginx.conf` **is** that config, lifted and given TLS; it is the file to copy now, and §11.2 predates it.

### The certificate key's permissions are not the shape to copy

`deploy/staging/tls/staging-key.pem` is `chmod 0644`, because nginx runs as uid 101 inside the container and reads the key through a bind mount, and a 0600 file owned by the host user is unreachable to it. This is a throwaway certificate for a loopback origin in a directory git will not accept. **A real deployment injects its key through the platform's secret mechanism and never through a bind mount.** `deploy/staging/.gitignore` explains why none of `tls/`, `.env.staging`, `release-manifest.json` or `staging-verified.json` is ever committed — the last one especially: `promote` trusts the attestation, so a committed one would let a promotion inherit another machine's verdict.

---

## 5. `TRUST_PROXY=true` and the `X-Forwarded-For` overwrite

These are two halves of one control and **both are required**. Either half alone is a defect, and the two defects look nothing alike.

**`TRUST_PROXY=true`** tells Fastify to take `request.ip` from the leftmost `X-Forwarded-For` value. Guest creation is rate limited on that address — ten per minute — because the endpoint hands out a fresh session cookie, so a session-keyed limit would never accumulate.

**With `TRUST_PROXY=false` behind a proxy**, `request.ip` becomes the *proxy's* address for every browser in the world. The whole deployment then shares one address-keyed bucket: **ten guest sign-ups a minute for everybody**, exhausted by one script, a self-inflicted denial of service that in the logs looks exactly like the limiter working. This is the safe-looking misconfiguration and it is not safe ([`architecture.md`](architecture.md) §2).

**With `TRUST_PROXY=true` behind a proxy that appends rather than overwrites**, the mirror image: a client sends its own `X-Forwarded-For`, lands in a fresh bucket on every request, and creates guests without limit. `$proxy_add_x_forwarded_for` — the spelling most nginx configurations on the internet use — preserves the client's value and is exactly this bug. `deploy/staging/nginx.conf` uses `$remote_addr`.

A comment is not a control, so `staging up` proves it. It sends 24 guest creations through the proxy with 24 **different forged client addresses**, after the smoke test has already exhausted the genuine bucket for that client — which makes the proof strictly stronger, because a success from a forged address could then only have come from bucket-hopping. Measured 2026-08-22: **24 of 24 refused**, so the forged header chose nothing.

`TRUST_PROXY=true` is only defensible here because the API publishes no port at all. There is no route to it except through the proxy. `docs/RUNBOOK.md` §11.2 states the same condition for production: turn it on **only if** the API is unreachable except through that proxy.

---

## 6. What `staging up` verifies

Not "it started". In order, and each of these is a failure that stops the run:

1. the manifest's references are content digests (`name@sha256:<64 hex>`), or it refuses — a tag is a pointer, and the whole build-once chain depends on content addressing;
2. postgres is healthy; `migrate.mjs roles` and `migrate.mjs up` applied; the runtime login identity `prl_api` created with a generated password and **proven bounded** — `USAGE` on schema `prl`, and *not* `CREATE`;
3. every service is running and healthy;
4. the **running containers carry the manifest's digests**, read from `docker inspect` rather than from a tag;
5. `https://localhost:8443/api/v1/ready` answers 200, with the chain **verified** against the local CA;
6. the proxy sets `Strict-Transport-Security` — the one header neither the app nor the API can set honestly, because only the terminator knows there is TLS;
7. `scripts/smoke-test.mjs --strict` over https: guest sessions, CSRF enforcement, content, calculation, rooms, the hidden-information property over a real `wss://` WebSocket, hand-history isolation, the CSP on the rendered page, and rate limiting;
8. the `X-Forwarded-For` overwrite proof in §5.

`deploy/staging/staging-verified.json` is written **only** when every check *and* the strict smoke test passed. Its absence is a refusal, not a warning: nothing has earned a promotion.

### The run of 2026-08-22

| Command | Exit | Result |
| --- | --- | --- |
| `node scripts/release-artifacts.mjs --force` | 0 | built `prl-api` (83 MB) and `prl-web` (171 MB) once each. api `sha256:65299822f90c7ef247044cd0462ac54fef250386ea114bfdec4dcc1d6401d4ab`, web `sha256:301dc58757d7c24a5f922ac9a36390f04d548bc5244c5f14f5ec3b31205d64ff` |
| `node scripts/staging.mjs up` | **1** | the stack came up and every infrastructure check passed; the smoke test then found two application defects — 53 checks passed, 2 failed. **No attestation was written**, which is the correct behaviour |
| `node scripts/staging.mjs status` | 0 | all four services running/healthy, "api matches the manifest", "web matches the manifest", "attestation absent — nothing has been verified" |
| `node scripts/staging.mjs promote` | **1** | refused: `nothing has been verified in staging` |
| `node scripts/staging.mjs down --volumes` | 0 | all containers, the network and the volume removed; the development postgres container untouched |

What passed inside that failed `up`, in the script's own terms: postgres healthy; roles and migrations applied; `prl_api` created and proven bounded; all four services running/healthy; **both running containers matched the manifest digests**; `https /api/v1/ready` 200 with the chain verified against the local CA; HSTS present; and 24/24 forged-address guest creations rate limited.

The two smoke failures were `live hand: timed out` and `guest bootstrap: no session cookie`. Both are §8.

---

## 7. What staging does not prove

Stating this is the point of the section. A rehearsal that overclaims is worse than none.

- **Capacity, of anything.** One replica on one machine with the database on the same kernel is not a load test. [`load-test.md`](load-test.md) holds the measured ceiling with the environment it was measured in attached; `scripts/load-test.mjs` says the same about itself.
- **A second API replica.** There must not be one — see §3.
- **A registry-attested digest.** There is no registry and nothing is pushed. The digest is the one BuildKit's exporter assigns in the local image store: the value `--iidfile` writes, the value `docker image inspect --format '{{.Id}}'` reports, the value in `RepoDigests`. The manifest records this in its own `digestKind` field: *"local BuildKit image-store manifest digest (--iidfile). Content-addressed and stable, but not registry-attested: nothing is pushed, so no registry vouches for it."* It cannot be two different images; nobody signed it.
- **A deploy identity.** Migrations here run as the cluster owner, the way `.github/workflows/ci.yml` does, because this stack creates its own throwaway cluster on every bring-up. A real deployment migrates as `prl_deployer` (`docs/RUNBOOK.md` §5, §11.3). The *runtime* identity **is** rehearsed, and that is the one whose missing `GRANT` would otherwise surface in production.
- **A production rollout or a rollback.** There is no deploy target. See [`deployment.md`](deployment.md) §7 and [`rollback.md`](rollback.md).
- **A real certificate authority, HSTS preloading, or a plaintext-to-TLS redirect.** There is deliberately no port-80 listener: a redirect means the staging origin answers on http, which is an origin somebody bookmarks and a first request that carried a cookie in the clear before the redirect was read. Connection refused is unambiguous. A production edge in front of a real domain *does* want the redirect, and `includeSubDomains` and `preload` on its HSTS header, decided deliberately at the edge that owns the public DNS name.

### `RATE_LIMIT_RESET_TOKEN` cannot be set here

`NODE_ENV=production` in staging, and `apps/api/src/config.ts` **refuses to boot** when that token is set in production: it empties the rate limiter, which for its holder is equivalent to turning rate limiting off. The refusal exists for the realistic failure — a `.env` copied from staging to production with one variable nobody re-read — so staging is a production environment for that purpose too.

The cost is real and is accepted: the smoke harness cannot reset the limiter between phases and **falls back to waiting out the rate-limit window**. That is slower, and it is honest.

---

## 8. What the first real run found

Both are application defects outside `deploy/staging/`, neither could have been found by the test suite or the development stack, and **both are now fixed**. They are recorded here because they are the argument for the environment existing.

### 1. Monte Carlo equity was dead under `NODE_ENV=production`

`monteCarloEquity` called `createDeterministicRandomForTests`, and that function throws when `NODE_ENV === 'production'` by design (`packages/poker-engine/src/rng.ts`). So the Coach could not answer, and a bot needing a sampled estimate never acted: the hand never completed and the table stopped. The API log showed `a bot policy failed to decide` with `RandomnessError: createDeterministicRandomForTests must never be used in production`.

The exact-enumeration path was unaffected, which is precisely why the smoke test's equity check passed and the live hand did not — and why nothing before this run had caught it. Fixed with a production-legal `createSamplingRandom`.

### 2. Guest bootstrap was refused behind any reverse proxy

`apps/web/src/proxy.ts` minted the guest with `origin: request.nextUrl.origin` — the container's own listening address, not the public one. The API correctly answered 403 `cross-origin POST from an origin that is not allowlisted`, and the reader got no session.

This works on the development stack only by coincidence: there the proxy publishes port 3000 and web listens on 3000, so the two spellings happen to match. It could not be fixed at the proxy — no forwarded header changed the answer — and it could not be worked around by allowlisting the wrong origin, because `PUBLIC_WEB_ORIGIN` refuses a plaintext entry in production and the port would still be wrong. Fixed with `apps/web/src/lib/public-origin.ts`.

### The outstanding item

**Because both fixes landed after that run, `staging up` has not yet been re-run to produce a green attestation, and no promotion has completed end to end.** The refusal paths are proven — `promote` refused with `nothing has been verified in staging`, and with a synthetic attestation naming a different api digest it printed both digests (`about to promote  sha256:65299822…` / `staging tested    sha256:0000…`) and also flagged the dirty working tree. The success path is implemented and is not yet evidenced. Do not read this document, or [`deployment.md`](deployment.md), as saying otherwise.

---

## 9. Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `deploy/staging/.env.staging does not exist` | never initialised | `pnpm run staging init` |
| `no release manifest at deploy/staging/release-manifest.json` | the artefacts were never built, or were pruned | `pnpm run release:artifacts` |
| `required variable PRL_API_IMAGE is missing` | a raw compose command without `--env-file` | add `--env-file deploy/staging/.env.staging`, or use `pnpm run staging` |
| `PRL_STAGING_PUBLIC_ORIGIN and PRL_STAGING_HTTPS_PORT disagree` | the origin and the published port drifted | `pnpm run staging init --origin <url>` — a mismatch otherwise presents as "every WebSocket closes 4406" |
| every WebSocket closes `4406` | `PUBLIC_WEB_ORIGIN` is not exactly the origin the browser used | fix the variable. **Never** widen the allowlist to silence it — that is the only defence on the socket boundary |
| the API container is healthy and unreachable | `HOST` bound to loopback | it comes from the image's own `ENV`; do not override it in compose |
| postgres will not start against an existing volume | the volume was created by an earlier stack running as root | `pnpm run staging down --volumes`; staging data is disposable by definition |
| `the running api container is not the manifest's artefact` | something rebuilt or retagged behind the manifest | rebuild with `release:artifacts` and bring the stack up again; never hand-edit the image variables |

`pnpm run staging logs --service api --tail 200` is the first thing to read for anything not in that table.

`/metrics` is deliberately not reachable from the public origin — it is not under `/api/`, so the proxy sends it to the page server, which 404s. Scrape it from inside the network:

```bash
docker compose --env-file deploy/staging/.env.staging -f docker-compose.staging.yml \
  exec api node -e "fetch('http://127.0.0.1:3001/metrics',{headers:{authorization:'Bearer '+process.env.METRICS_TOKEN}}).then(r=>r.text()).then(console.log)"
```
