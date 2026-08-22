# Production architecture

`docs/ARCHITECTURE.md` explains the shape of the *software*. This document explains the shape of the *deployment*: what runs where, what trusts what, what fails independently, and which properties an operator must not break.

Everything here is a constraint on how this system may be run. Where a constraint has a cost, the cost is named.

---

## 1. Topology

```
                          Internet
                              │
                              │  https, TLS terminates here
                              ▼
                  ┌────────────────────────┐
                  │   Reverse proxy         │  ONE published origin
                  │   ───────────────       │
                  │   TLS · HSTS            │
                  │   WebSocket upgrade     │
                  │   overwrites XFF        │
                  └───────┬────────┬────────┘
                          │        │
            /  and  /_next│        │/api/*  and  /api/v1/ws
                          ▼        ▼
              ┌────────────────┐  ┌──────────────────────────────┐
              │ web (Next.js)  │  │ api (Fastify)                 │
              │ not published  │  │ not published                 │
              │ ────────────── │  │ ───────────────────────────── │
              │ SSR + CSP nonce│  │ REST + WebSocket hub          │
              │ proxy/middleware│ │ LIVE TABLE STATE IN MEMORY    │
              │ guest bootstrap│  │ Monte Carlo worker threads    │
              └────────────────┘  └───────────────┬──────────────┘
                                                  │  prl_api / prl_app
                                                  ▼
                                       ┌────────────────────┐
                                       │   PostgreSQL 16     │
                                       │   schema `prl`      │
                                       │   owned by          │
                                       │   prl_migrator      │
                                       └────────────────────┘
```

**One published origin.** The browser talks only to the proxy, sends relative `/api/*` paths, and never learns the API's address. Two published origins would let a reader land on the one where relative `/api/*` goes nowhere — which is why the web service is deliberately not published.

**The API address is not baked into the client.** `NEXT_PUBLIC_*` is banned in this repository: any such value is inlined into the bundle at build time, so a built image could never be pointed at its own API. The web container refuses to boot if a build-time-only variable appears in its environment, because a silent no-op there is exactly how the previous defect stayed hidden. Retargeting is the proxy's job.

---

## 2. Trust boundaries

| Boundary | Crossing | Enforcement |
| --- | --- | --- |
| Internet → proxy | anything | TLS, HSTS |
| Proxy → API | HTTP + WebSocket upgrade | `TRUST_PROXY=true` **and** the proxy overwrites `X-Forwarded-For` |
| Browser → API (CORS) | credentialed `fetch` | exact origin allowlist, never a wildcard, never reflection of an unknown origin |
| Browser → API (WebSocket) | upgrade with cookies | **the `Origin` header, and nothing else** |
| Session → resource | every read of a room or hand | authorisation in the `WHERE` clause of every query |
| Server → client | every frame and every response | redaction by construction — a client view is *built* from a projection, never filtered from full state |
| API → database | every query | least-privilege roles; the serving credential cannot alter the schema |

### The WebSocket boundary deserves its own paragraph

A browser sends cookies on a cross-origin WebSocket handshake, and **CORS does not apply to WebSockets at all**. Page script cannot set a header on `new WebSocket()`, so the double-submit CSRF token that protects every mutating HTTP request is unavailable here. The `Origin` header — which browsers always send on a handshake and page script cannot forge — is therefore the *only* server-side signal, and `isAllowedOrigin` is exported from the security layer specifically so the hub can call it before accepting the upgrade.

An operator who widens `PUBLIC_WEB_ORIGIN` to silence `4406` refusals has removed the only defence on that boundary. It is listed in the runbooks as something never to do.

### The proxy boundary is a two-sided mistake

`TRUST_PROXY=false` behind a proxy is the *safe-looking* misconfiguration and it is not safe. `request.ip` becomes the proxy's address for every browser in the world, so the routes that key on address rather than session — guest creation and OIDC, which must key on address because they *issue* the session an address-free key would rotate — collapse into a single bucket. The whole deployment then shares ten guest sign-ups per minute, exhausted by one script, for everybody. In the logs this looks exactly like the limiter working.

`TRUST_PROXY=true` without a proxy that **overwrites** `X-Forwarded-For` is the other side: any caller forges their own address and defeats address-based limiting entirely.

Both halves are required together. The server emits a boot warning when `TRUST_PROXY` is false while `HOST` binds every interface, because that combination is almost always the first case misconfigured as the second.

---

## 3. Failure domains

| Component | Fails independently? | What survives | What is lost |
| --- | --- | --- | --- |
| Proxy | yes | nothing reachable | all access |
| Web | yes | the API and live sockets already established | server-rendered pages |
| API process | **no — this is the important one** | hand history, progress, rooms (in the database) | **every hand in progress** |
| Worker threads | yes | all gameplay | Coach and equity analysis, which refuse rather than degrade |
| Database | yes | gameplay in progress | sign-in, room creation, joining, history, and archive writes |

### The one architectural fact that shapes every operational decision

**Live table state is held in memory by exactly one API process** (`docs/adr/0001-modular-monolith.md`). Consequences, all of which an operator must hold in mind:

- Restarting the API **drops every hand currently in progress.** Bot seats rehydrate from the database and rooms reopen on next access, but the in-memory hand does not come back. "Just restart it" is never free here.
- There is no failover for a table. There is only "the process that holds it".
- Horizontal scaling spreads **tables**, never one table. A load balancer must not move a session between instances mid-table.
- The database being unhappy degrades *history*, not *gameplay*: archive writes are deliberately non-blocking, so a hand plays out correctly and only its record is at risk.

This is an accepted trade, not a hidden defect. It buys the whole-state, server-authoritative model that makes the correctness and hidden-information guarantees provable. It is stated here because every runbook depends on the reader knowing it.

---

## 4. Data flows

### A hand

```
browser ── WebSocket action ──► API ──► LiveTable (in memory)
                                  │        │
                                  │        ├─► engine.applyAction  (pure, synchronous)
                                  │        └─► redactFor(seat)     (projection, per seat)
                                  │
                                  ├─► whole-state frame ──► every seat, each its own view
                                  │
                                  └─► archive (non-blocking, best effort) ──► PostgreSQL
```

Whole snapshots rather than deltas (`docs/adr/0009`). A delta protocol requires the client to hold state the server would then have to trust, and a dropped delta silently desynchronises a table. The cost is larger frames, which is why frame size is a real consideration in the event-loop budget.

Each seat receives a *different* frame, built from a projection for that seat. There is no single "full state" object that gets filtered on the way out — that design is what makes a leak a construction error rather than a missed filter.

### An analysis

```
browser ──► API ──► worker pool (bounded queue, N threads) ──► Monte Carlo / exact
                          │
                          └─ queue full ──► service_unavailable, immediately
```

Refusing immediately is the design. An unbounded queue turns a CPU limit into a memory limit and a latency limit into neither: every caller waits, then fails, having consumed a slot anyway.

### A session

```
browser ──► POST /auth/guest ──► users row (kind='guest') + session row
                                      │
                                      └─ cookie: signed, httpOnly, Secure, SameSite=Lax,
                                                 __Host- prefixed in production
```

Sessions store **only digests**: sha256 of the token, and HMAC of the address and user agent. No raw address and no raw user agent is stored anywhere.

---

## 5. What runs in production, and what must not

| Property | Required | Why |
| --- | --- | --- |
| `NODE_ENV=production` | yes | switches HSTS on, `__Host-` cookie prefixes on, and every relaxed development check off |
| `COOKIE_SECURE=true` | yes | refused at boot otherwise |
| TLS at the proxy | yes | a `Secure` cookie is never sent over plaintext, so sign-in simply would not work |
| Digest-pinned images | yes | a tag is mutable; a digest is the artefact |
| Non-root containers | yes | asserted in CI |
| Dependencies installed at runtime | **never** | the image is the artefact; installing at runtime means the running thing was never tested |
| Source bind-mounted | **never** | same reason |
| `RATE_LIMIT_RESET_TOKEN` | **never** | the process refuses to boot with it. It unlocks a control that empties the rate limiter, which is equivalent to disabling rate limiting for whoever holds it |
| Public matchmaking | **never** | enforced by a database CHECK constraint, not by application code |
| Real-money anything | **never** | there is no such code path and there must never be one |
| `PRL_LEGEND_NAMING=attributed` | not without written legal review | the production default is `archetype` |

The last three are product guarantees, not configuration preferences. `docs/PRODUCT-GUARDRAILS.md` and `docs/adr/0010` are binding.

---

## 6. Scaling model, honestly

**Vertical, then horizontal by table.**

One API process holds tables in memory, so throughput per instance is bounded by the event loop for socket and request work and by `MONTE_CARLO_WORKERS` for analysis. The measured ceiling for one instance is in [`load-test.md`](load-test.md) — with the environment it was measured in attached, because a number without that is a guess wearing a decimal point.

Adding instances adds *table* capacity. It does not make one table faster and it does not survive an instance loss for a table that instance was holding. Session affinity is required: a learner must reach the instance holding their table.

The database is shared and is the only stateful component that can be scaled independently. `DATABASE_POOL_MAX` is **per process**, so total demand is `pool_max × instances` and must fit the server's `max_connections` with headroom for migrations and operators. Over-provisioning the pool across instances is the most common way to saturate a database that has plenty of CPU left.

---

## 7. Build and promotion

**Build once, deploy by digest, promote the same digest.**

```
commit ──► security gates ──► tests ──► BUILD (once) ──► digests recorded
                                              │
                                              ├─► container CVE scan
                                              ▼
                                          staging (same digest)
                                              │  smoke + E2E
                                              ▼
                                    controlled promotion
                                              │  SAME digest, verified byte-identical
                                              ▼
                                          production
                                              │
                                              └─► post-deploy verification
```

A rebuild between staging and production means production runs an artefact nothing tested. The promotion step refuses a digest that differs from the one staging tested, and prints both.

Details in [`deployment.md`](deployment.md); reversal in [`rollback.md`](rollback.md); the environment in [`staging.md`](staging.md).

---

## 8. Migrations

Schema changes run **from outside the serving container**, as `prl_migrator`, before the new application version starts. The serving credential (`prl_app`/`prl_api`) cannot alter the schema — two roles exist precisely so that a compromised runtime cannot rewrite the database.

Migrations are **roll-forward only**. `migrate.mjs` refuses `down`, because a down migration that drops a column destroys data an application rollback would not have needed to destroy. The consequence is the two-release rule (`docs/RUNBOOK.md` §11.3): the additive half of a change ships first, so old and new code can both run against the intermediate schema, and only then does the destructive half ship. **A migration that skips the additive-first step cannot be rolled back around** — which is the reason for the rule, not a side effect of it.

---

## 9. Observability surfaces

Three, answering different questions, with a deliberate separation between them:

- **Metrics** (`GET /metrics`, token-authenticated) carry **no identifiers at all** — no user, session, room or hand id — so they can be scraped into a long-retention store with weak access control.
- **Structured logs** (stdout, JSON) carry per-entity detail, correlated by request id, governed by retention and access policy.
- **Probes** (`/api/v1/health`, `/api/v1/ready`) answer a single question for an orchestrator. Liveness answers from memory and is rate-limit exempt; readiness queries the database and is not.

Nothing that identifies a person, a table or a hand crosses from logs into metrics. Details in [`observability.md`](observability.md); thresholds and rationale in [`alerts.md`](alerts.md).

---

## 10. Backup and recovery

PostgreSQL is the only durable state. Live table state is not backed up and cannot be — it exists for the duration of a hand.

RPO, RTO, the retention policy, the encryption design and the evidence from an actual restore are in [`backup-restore.md`](backup-restore.md) and [`disaster-recovery.md`](disaster-recovery.md).

---

## 11. What this architecture deliberately does not have

Each of these is an absence somebody would otherwise assume is an oversight.

- **No cache tier.** Content is served from memory and per-learner responses are `no-store` by construction — a shared cache holding a personalised response is a way to serve one learner's page to another. A cache would be a new place for that to go wrong for no measured gain.
- **No message queue.** One process owns a table; there is nothing to hand off.
- **No distributed tracing.** One process and one database. A request id in the logs plus route-level histograms covers what a trace would, for a span depth of about two.
- **No session store outside Postgres.** Adding Redis would add a failure domain to save one indexed query.
- **No public matchmaking, no chat, no user-to-user content.** Deliberate (`docs/adr/0010`), and it removes an entire category of moderation and abuse surface. Do not add one without the moderation work that would then be required.
- **No LLM in the request path.** Strategy profiles are probabilistic policies, not models pretending to be people (`docs/adr/0011`, `docs/adr/0012`). Nothing generates a "thought" for a named person.
- **No real-money code path, ever.** Not disabled — absent.
