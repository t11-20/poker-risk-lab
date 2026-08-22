# Staging verification

**Candidate SHA:** `4a17e3cec3a6418be34ee7b3efd69cbfe84446b2` (clean tree).
**Images built once** by `node scripts/release-artifacts.mjs --force` on that SHA (`{SCRATCH}/containers-build.log`, `ARTIFACTS_EXIT=0`).

`{SCRATCH}`:
`/var/folders/7s/l9fr0tyd4wn9vp8qhg9yv7g80000gn/T/grok-goal-843cf6607006/implementer`

---

## Digests

Local BuildKit image-store digests. Content-addressed. **Not registry-attested.** Nothing was pushed.

| Service | Tag | Digest |
| --- | --- | --- |
| api | `prl-api:4a17e3cec3a6` | `sha256:9a8457e8ae427d64b7cd2aa4da65f2a978cc55ad347d1842c6822e8beba72abe` |
| web | `prl-web:4a17e3cec3a6` | `sha256:34ba79323e2e0be06a7f935351401a3cc6ae8b9b1561e371d1cfa05263dccbb2` |

Recorded in `{SCRATCH}/digests.txt` and `deploy/staging/release-manifest.json` (gitignored). `commit.dirty` is **false**.

Previous local pair used for rollback (SHA `1e49f878f7df`, dirty):

| Service | Digest |
| --- | --- |
| api | `sha256:65299822f90c7ef247044cd0462ac54fef250386ea114bfdec4dcc1d6401d4ab` |
| web | `sha256:301dc58757d7c24a5f922ac9a36390f04d548bc5244c5f14f5ec3b31205d64ff` |

---

## Image CVE scan

`node scripts/supply-chain/container-scan.mjs --manifest deploy/staging/release-manifest.json`

- trivy 0.72.0, severity floor HIGH
- api (debian 12.15): 30 HIGH+ findings, **30 with no available fix**
- web (debian 12.15): 30 HIGH+ findings, **30 with no available fix**
- **0 blocking, 60 unfixable, 0 allowed**
- `CONTAINERS_EXIT=0` (`{SCRATCH}/containers.log`)

These are real vulnerabilities in a shipped Debian image. They do not block because the only remediation is a different base image.

---

## Stack

```
node scripts/staging.mjs init --origin https://localhost:8443   # INIT_EXIT=0
node scripts/staging.mjs up --manifest deploy/staging/release-manifest.json
# STAGING_UP_EXIT=0
```

`docker-compose.staging.yml` has **no `build:`**. `NODE_ENV=production`. `RATE_LIMIT_RESET_TOKEN` is absent (the API refuses to boot with it in production). TLS terminator is nginx. WebSocket upgrades go through the proxy, not through `next start`.

`{SCRATCH}/staging.log` and `{SCRATCH}/staging-verify.log`:

| Check | Result |
| --- | --- |
| Running api/web containers match the manifest digests (`docker inspect`) | PASS |
| `https://localhost:8443/api/v1/ready` | **200** `{"status":"ready","checks":{"database":{"ok":true},"workers":{"ok":true}}}` — body is actually ready, chain verified against `deploy/staging/tls/staging-ca.pem` |
| `https://localhost:8443/api/v1/health` | 200 |
| HSTS | `max-age=31536000; includeSubDomains` (proxy) |
| API CSP on `/ready` | `default-src 'none'` (and the rest of the deny list) |
| Runtime identity | `prl_api` is a member of `prl_app`, USAGE on `prl`, no CREATE |
| Strict smoke through the proxy, including `wss://` | **61 checks passed** |
| Guest session cookie over HTTPS | `__Host-prl_session` |
| Proxy overwrites `X-Forwarded-For` | 24/24 forged addresses rate-limited into the real client bucket |
| `pnpm run staging promote` | **promotable: true**, byte-identical to the attested digests |

Attestation: `{SCRATCH}/staging-verified.json` (copied from `deploy/staging/staging-verified.json`).

`promote` **verifies**. It does not push and does not deploy. There is no registry in this repository.

---

## Observability / alerts

Metric families named in `alerts.md` **are exported** by this SHA (`{SCRATCH}/metrics-3104.txt`: `prl_readiness_state`, `prl_http_requests_total`, `prl_event_loop_delay_*`, `prl_worker_pool_*`, `prl_db_probe_duration_seconds`, `prl_rate_limit_events_total`, `prl_process_start_time_seconds`, …).

The conditions that would fire `ApiDown` / `ApiNotReady` were **produced**:

- drills: `/ready` 503 while DB frozen; `/health` stayed 200
- rollback: stop api → origin `/ready` nginx **504**

`docker-compose.staging.yml` contains **no Prometheus, Alertmanager, or Grafana**. No paging notification was delivered.

**Alert delivery: UNVERIFIED.** Capture: `{SCRATCH}/alert-fire.log`.

---

## What this is not

- A capacity test (see `load-test.md`).
- A registry-attested promotion path.
- Proof that a second API replica is safe — it is not; `deploy.replicas: 1` is a correctness constraint.
