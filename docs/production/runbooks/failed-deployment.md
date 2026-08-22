# Failed deployment

A deploy did not reach a healthy state, or reached one and is serving wrongly.

Read [README.md](README.md) first. Two facts change everything below: **restarting the API drops every hand in progress**, and **the schema does not roll back** ([`../rollback.md`](../rollback.md)). The forward path this runbook is about is [`../deployment.md`](../deployment.md).

---

## Symptoms

- A pipeline step exits non-zero: the build, the container scan, the staging bring-up, or the promotion check.
- Containers start and never become healthy; `depends_on: service_healthy` never satisfies and the proxy never starts.
- The deploy reports success and `GET /api/v1/ready` returns 503.
- The public origin answers 502 or 504.
- The process exits immediately with code 78 and a list of configuration problems.
- The process crash-loops.
- Learners see the page load with no data, or every WebSocket closes with `4406`.
- `pnpm run staging promote` refuses.

## Detection

Start with the three facts from [README.md](README.md), then narrow by stage.

```bash
curl -sS -o /dev/null -w 'health %{http_code}\n' "$API/api/v1/health"
curl -sS -o /dev/null -w 'ready  %{http_code}\n' "$API/api/v1/ready"
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep -E 'prl_process_start_time_seconds|prl_readiness_state|prl_api_errors_total'
```

| Alert | What it means here |
| --- | --- |
| `ApiDown` | the new version is not serving at all |
| `ApiNotReady` | the process is up and the database is not reachable from it — often a `DATABASE_URL` that names the wrong role or host |
| `ProcessRestartLoop` | the new image is crashing on start; usually configuration (exit 78) or a missing module |
| `ReadinessFlapping` | readiness is oscillating; the roll has not settled, or the pool cannot hold a connection |
| `HttpErrorRateHigh` | the new version is serving and getting it wrong. This is a rollback trigger |

Against a staging stack, `status` answers the same questions in one command:

```bash
pnpm run staging status
```

It prints each service's state and health, the running image digest, whether each matches the manifest, and whether an attestation exists (`attestation absent — nothing has been verified`).

## Immediate containment

**Stop the rollout.** Whatever stage failed, do not let the next one start. A half-rolled deployment across two versions is worse than either version.

**Keep the previous digest serving.** If the previous version is still up, leave it up. If the new one is already serving and failing, go to [rollback.md](rollback.md) — do not diagnose first while learners are on the broken version.

**Do not rebuild.** This is the most tempting wrong move. A rebuild produces a **different digest**, so the artefact staging tested no longer exists and every downstream check is now about something else. `scripts/release-artifacts.mjs` refuses to rebuild a commit whose manifest is still valid for exactly this reason; if you find yourself reaching for `--force` during an incident, stop.

**Do not re-run migrations by hand to "get past" a step.** The runner takes an advisory lock and refuses edited files on purpose. See [failed-migration.md](failed-migration.md).

**Do not weaken a control to get a green deploy.** Not the CSP, not the rate limit, not the origin allowlist, not `COOKIE_SECURE`. A refused boot is the system telling you the configuration is wrong.

**Capture evidence before tearing anything down.** `pnpm run staging down` removes `staging-verified.json` and, with `--volumes`, the database. Take the logs first:

```bash
pnpm run staging logs --tail 300 > /tmp/prl-failed-deploy.log
pnpm run staging status --json > /tmp/prl-failed-deploy-status.json
```

## Diagnosis

Work from the stage that failed. Each row below is a message the tooling actually emits.

### The build stage

| Message | Meaning | Action |
| --- | --- | --- |
| `A valid manifest for this exact commit already exists` | not a failure — a refusal to build twice | use the existing digests, or `--force` if you genuinely mean a new artefact |
| `runs as 'root', expected 'node'` | the image ships as root | a Dockerfile regression; fix before anything else |
| `N markdown file(s) in the image` | `.dockerignore` regressed | this is how `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` once shipped inside the published web image |
| `environment file(s) in the image` | a `.env` entered the build context | treat as a credential exposure: [leaked-secret.md](leaked-secret.md) |
| `the digest from --iidfile … and the one from docker image inspect … disagree` | the identity assumption this pipeline rests on has stopped holding on this Docker version | stop. Every downstream comparison is meaningless until this is understood |

### The container scan

A blocking finding is one **at or above HIGH with an upstream fix available**. Unfixable findings are counted and reported and do not block. If the scan refuses rather than fails — trivy missing, its database unreachable, or no OS identified — the correct reading is *nobody checked*, not *nothing found*. Do not proceed on a refusal.

### The staging bring-up

| Message | Cause |
| --- | --- |
| `no release manifest at deploy/staging/release-manifest.json` | the artefacts were never built on this machine, or were pruned |
| `does not give service "api" a digest reference` | the manifest names a tag; staging deploys by digest and refuses a pointer |
| `staging has not been initialised` | no `.env.staging` or no TLS chain — run `pnpm run staging init` |
| `the staging certificate expired N day(s) ago` | the 90-day local certificate lapsed — `init` again |
| `PRL_STAGING_PUBLIC_ORIGIN and PRL_STAGING_HTTPS_PORT disagree` | the origin and the published port drifted; this presents downstream as **every socket closing 4406** |
| `postgres never became healthy` | usually a data volume created by an earlier stack that ran as root — `down --volumes` |
| `applying migrations failed` | [failed-migration.md](failed-migration.md) |
| `could not create the runtime login identity` | the role SQL failed, or the identity has `CREATE` on schema `prl` when it must not |
| `the stack never became healthy` | read the per-service logs the command dumps; the API healthcheck requires **both** `/api/v1/health` and `/api/v1/ready`, so this often means the database, not the API |
| `the running api container is not the manifest's artefact` | something rebuilt or retagged behind the manifest. **Never** hand-edit `PRL_API_IMAGE` to make this pass |
| `… /api/v1/ready did not answer 200` | the proxy, the API, or the database — take them in that order using the logs |
| `no Strict-Transport-Security header` | the proxy configuration is not the one in `deploy/staging/nginx.conf` |
| `the smoke test failed against the staging origin` | an application defect. This is what the environment is for — see [`../staging.md`](../staging.md) §8 |
| `the proxy did NOT overwrite X-Forwarded-For` | the config uses `$proxy_add_x_forwarded_for`; with `TRUST_PROXY=true` every client can now choose its own rate-limit bucket |

### The promotion check

| Message | Meaning |
| --- | --- |
| `nothing has been verified in staging` | no attestation. `up` writes it only when every check *and* the strict smoke test passed. This is a refusal, not a warning |
| `api is NOT the digest staging tested` | it prints **both** digests: `about to promote` and `staging tested`. Something rebuilt between the two steps |
| `the manifest was built from a dirty working tree` | the recorded commit does not describe the bytes that were built |

### Production symptoms after a deploy that "succeeded"

| Symptom | Cause |
| --- | --- |
| exit **78**, a list of configuration problems, never listened | `ConfigError`. Common: `SESSION_COOKIE_SECRET` missing or a placeholder, `PUBLIC_WEB_ORIGIN` with a trailing slash or a path, `COOKIE_SECURE=false`, or `RATE_LIMIT_RESET_TOKEN` present in production |
| healthy container, unreachable service | the server bound to loopback. `HOST` comes from the image's own `ENV` for this reason; the healthcheck probes the container's own network address so this cannot masquerade as working |
| every WebSocket closes `4406` | `PUBLIC_WEB_ORIGIN` is not exactly the origin the browser used. **Never** widen the allowlist to silence it: `Origin` is the only defence on that boundary ([`../architecture.md`](../architecture.md) §2) |
| sockets closing `1006` on every roll | the orchestrator's grace period is at or below `SHUTDOWN_GRACE_MS`. Not a release defect |
| guest sign-up fails behind the proxy | the public origin the web tier sends is not the browser's — the defect described in [`../staging.md`](../staging.md) §8 |
| the whole deployment shares 10 guest sign-ups a minute | `TRUST_PROXY=false` behind a proxy. In the logs this looks exactly like the limiter working |

## Recovery

| Situation | Action |
| --- | --- |
| The new version is serving and failing | **roll back** — [rollback.md](rollback.md). Do not diagnose on the broken version |
| The new version never started (exit 78) | fix the variable and redeploy. The artefact is fine; a rollback would hide a misconfiguration that recurs |
| The bring-up failed before anything served | fix the cause and re-run. Nothing was deployed, so there is nothing to roll back |
| A migration failed | [failed-migration.md](failed-migration.md). **Do not let the application roll forward onto a schema it does not have** |
| The staging stack is in an unknown state | `pnpm run staging down --volumes`, then `up` again. Staging data is disposable by definition; capture logs first |
| The promotion check refused | that is the check working. Re-run staging on the digest you intend to ship, and let it write an attestation |
| The container scan blocked | fix the dependency or the base image. An allowlist entry needs a reason, an approver and an expiry, and the gate fails on a lapsed one |

Whatever the path, the artefact does not change. **The digest that goes to production is the digest staging tested**, or the deploy does not happen.

## Verification

```bash
# 1. The right bytes are running.
pnpm run staging status            # "api matches the manifest" / "web matches the manifest"

# 2. Both probes, through the public origin.
curl -fsS "$API/api/v1/health" && curl -fsS "$API/api/v1/ready"

# 3. No further restarts: take this twice, five minutes apart. It must NOT change.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_process_start_time_seconds

# 4. Hands complete again: started and completed rise together.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E 'prl_hands_(started|completed)_total'

# 5. End to end. This is the one that counts.
PRL_WEB_ORIGIN="$ORIGIN" node scripts/smoke-test.mjs --origin "$ORIGIN" --strict
```

Two probes returning 200 say the process is alive. The smoke test says a learner can get a session, join a room, play a hand to completion over a real WebSocket, and be correctly refused another learner's data. Against staging, `pnpm run staging up` runs it plus the TLS-chain, digest-identity and `X-Forwarded-For` checks, and writes an attestation only if all of them passed.

If the deployment was rolled back rather than fixed, confirm the schema is still **ahead** of the running code and leave it that way (`migrate.mjs status`).

## Escalation

Escalate when:

- The previous known-good digest also fails to start. That is not a deploy problem; the next suspects are the database and the environment.
- The running image does not match any digest anybody can account for. Treat it as a supply-chain question, not a deploy question: [dependency-compromise.md](dependency-compromise.md).
- The failed release contains a migration carrying `-- prl:irreversible:`. **There is no application rollback** — the reversal is a restore ([backup-restore.md](backup-restore.md)), and that decision needs a data owner, not an on-call engineer.
- Rolling forward would need a destructive database change. Stop and get a second person; there is no deploy urgent enough.
- Any evidence that hidden state reached a client during the failure → [hidden-card-incident.md](hidden-card-incident.md) immediately, at page severity, regardless of whether service is restored.

Attach: the failing step's full output, the digests from the manifest and from `docker inspect`, the staging logs, the `/metrics` snapshot, the exit code, and the request ids from any learner reports.
