# Security

The controls this system carries, why each exists, and — for every one — the gate that proves it still works.

This document is not evidence. A control described here is real only because a named, runnable gate asserts it; where a control is asserted by nothing, this document says so rather than implying otherwise. The results of running those gates at a specific commit are in [`final-readiness-report.md`](final-readiness-report.md).

Companion documents: `docs/THREAT-MODEL.md` (assets, adversaries, trust boundaries), `docs/SECURITY.md` (disclosure), `docs/adr/0003-redaction-by-construction.md`, `docs/adr/0007-supply-chain-policy.md`.

---

## 1. What is actually at stake

Worth stating first, because it calibrates everything below. There is **no real money, no payment path, no cash-out, and no cryptocurrency** in this system — not disabled, absent. Learning units are valueless by construction and can be reset by their owner. Public matchmaking is off at the database level. There is no chat and no user-to-user content.

So the assets are, in order:

1. **Hidden game state** — hole cards, deck order, the deck cursor, commitment salts. Disclosing any of it destroys the premise the product rests on and cannot be undone.
2. **Learner data** — display name, federated identity, lesson and quiz progress, hand history.
3. **Session integrity** — a forged session is impersonation.
4. **Availability** and **correctness of the mathematics**, which is what the product teaches.

What is *not* at stake removes whole categories of threat, and the absence is deliberate.

---

## 2. Supply chain

| Control | Enforced by |
| --- | --- |
| Exact version pins, no ranges | `security:policy` |
| Frozen lockfile with integrity hashes | `pnpm install --frozen-lockfile`; `security:audit` |
| Lifecycle scripts disabled | `pnpm-workspace.yaml`, `--ignore-scripts` explicitly in both Dockerfiles **and** in CI; `security:shapes` |
| Known-bad package deny list | `security:denylist` |
| Mini Shai-Hulud IOC sweep | `security:ioc`, `docs/security/shai-hulud-snapshot-2026-08-17.md` |
| Dependency shape checks (unexpected binaries, install hooks) | `security:shapes` |
| Published-vulnerability scan | `security:osv` (allowlist entries require an expiry and a justification) |
| SBOM, CycloneDX 1.6, per build | `security:sbom` |
| Provenance | `security:provenance` |
| Container base images pinned by digest | `security:pinning` |
| CI actions pinned by SHA, least-privilege `permissions:` | `security:pinning` |
| Container image CVE scan | `security:containers` (trivy) |
| Repository hygiene — no NUL, no C0 controls, no bidi overrides, no zero-width characters, no CRLF | `security:hygiene` |

`pnpm run security:audit` chains the gates and is release-blocking. `supply-chain.yml` re-runs them daily, so a package that becomes bad after it was vetted is caught without a commit.

**A note on why lifecycle scripts being disabled matters more than it sounds.** A malicious package overwhelmingly acts at install time. With scripts off, a compromised package present in the graph has to be *imported* to do anything — which turns "it is in the lockfile" from a compromise into a question with an answer.

**Adding a dependency is a reviewed decision**, not a convenience. That is why the metrics layer in `apps/api/src/observability/` is hand-written rather than `prom-client`: the exposition format is a documented, stable serialisation that fits in one function, and the part that actually needs care — bounded label cardinality — is not something the library gives for free.

---

## 3. Transport and browser controls

| Control | Where | Note |
| --- | --- | --- |
| TLS | terminates at the proxy | a `Secure` cookie is never sent over plaintext, so sign-in would not work without it |
| HSTS, 1 year, `includeSubDomains` | API, production `NODE_ENV` only | `preload` deliberately off: submission is effectively irreversible and belongs to whoever owns the domain, not to a default in a source file |
| CSP (web) | per-response nonce, `strict-dynamic`, no `script-src` `'unsafe-inline'`, no `'unsafe-eval'` | asserted against a **running image**, not against a config file |
| CSP (API) | `default-src 'none'` with every fetch directive spelled out | the API returns JSON; nothing to relax |
| `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action` | both | `base-uri` and `form-action` are the two people forget: without them an HTML injection can still retarget relative URLs or post a form elsewhere |
| COOP / COEP / CORP | API | cheap, and they matter the day a route returns a document by accident |
| Referrer policy | `no-referrer` (API), `same-origin` (web) | an API URL can contain a room or hand id |

Proven by: `apps/web/test/csp-policy.test.ts`, `apps/web/test/theme-csp-hash.test.ts`, `apps/api/test/security-headers.test.ts`, and — the one that counts — `scripts/smoke-test.mjs` §10, which fetches a rendered page from the running web origin and fails if any `<script>` tag lacks the nonce, if two consecutive responses reuse a nonce, or if `unsafe-inline`/`unsafe-eval` appear in `script-src`.

### The known CSP residual

`style-src-attr 'unsafe-inline'` is present and confined to that directive. It permits inline **style attributes** only; it does not permit inline `<style>` elements and it has no bearing on `script-src`. It exists because React sets style attributes for dynamic layout, and removing it would mean a class for every computed value.

It is a real, if narrow, residual: an injection that can already set attributes on an element could restyle it. It cannot execute script, and `script-src` carries no `unsafe-inline`. Tracked as a P2, stated rather than quietly tolerated.

### Plaintext in development, and `upgrade-insecure-requests`

Development serves over `http://localhost`. HSTS is deliberately **off** outside production, because sending it from a development server pins `localhost` to https in the developer's browser for a year and is genuinely unpleasant to debug. Production serves only over TLS, so the directive and the transport agree there. The asymmetry is intended and is the reason the CSP is verified against a production-configured running image rather than against the developer stack.

---

## 4. Origin, CORS, CSRF and cookies

**CORS is hand-written** rather than taken from a plugin, because the whole policy is twenty lines and the one dangerous combination — `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true` — is then visible rather than hidden in an option object. Origins are matched **exactly**: never a prefix test (`endsWith('example.com')` also accepts `evil-example.com`), never a suffix test, never reflection of an unknown origin, and a literal `null` origin is refused because a friendly one cannot be told from a hostile one.

A cross-origin request from a non-allowlisted origin with a state-changing method is **refused outright**, not merely stripped of CORS headers. Without that, the side effect still happens and only the reading of the result is blocked.

**CSRF** is double-submit with a signed cookie and a single accepted header name, `x-csrf-token`. Narrowed to one name so the contract has exactly one answer, and the body form is dropped so the check can run before validation. It applies to every state-changing method and to nothing else: no `GET` in this API changes state, and requiring a token on `GET` would break both an ordinary link into the app and the OIDC provider's redirect back.

**Cookies**: `httpOnly`, `Secure` (refused at boot in production if not), `SameSite=Lax`, `Path=/`, no `Domain`, signed with HMAC-SHA256, and `__Host-` prefixed in production. `Lax` rather than `Strict` because the OIDC callback is a cross-site top-level navigation and a `Strict` cookie is not sent on one — every sign-in would fail. The residual (a cross-site `GET` navigation carrying the session) is covered by the two rules above.

**The WebSocket boundary is different and it is the one to get right.** Browsers send cookies on a cross-origin WebSocket handshake and **CORS does not apply**. Page script cannot set a header on `new WebSocket()`, so the CSRF token is unavailable. The `Origin` header — always sent, unforgeable by page script — is therefore the *only* server-side signal, which is why `isAllowedOrigin` is exported from the security layer for the hub to call before accepting the upgrade, and why widening `PUBLIC_WEB_ORIGIN` to silence refusals is listed in the runbooks as something never to do.

Proven by: `apps/api/test/security-headers.test.ts`, `apps/api/test/session-cookie-names.test.ts`, `apps/api/test/ws-socket.test.ts` (close 4406 / 4401), `apps/api/test/config-origin-shape.test.ts`, and smoke §CSRF.

---

## 5. Rate limiting

Two keying strategies, and the difference between them is a defect that was found by measurement rather than by review:

- **Ordinary routes** key on the session when there is one, and on a keyed hash of the address otherwise. Address-only punishes everyone behind one NAT; session-only lets anyone reset by discarding a cookie.
- **Session-issuing routes** — guest creation, OIDC start and callback — key on the **address**, ignoring the cookie. A route that *issues* a session hands the caller a fresh identity, so a session-keyed counter never accumulates. Measured against the running server: 60 consecutive guest creations produced **zero** 429s; freezing the cookie produced a 429 after six.

Keys are hashed, never raw: the rate limiter keeps keys in memory and hands them to `onBanReach` for logging, and neither should hold something replayable or an IP address.

Addresses are normalised so one caller is one bucket. `::ffff:203.0.113.4` and `203.0.113.4` are the same host, and Node reports the mapped spelling on a dual-stack socket and the plain one otherwise — two spellings means two buckets and a limit that quietly counts to half of what it says. `::1` and `127.0.0.1` are deliberately **not** folded together: those are genuinely different addresses.

### The test-isolation control, and why it cannot exist in production

`RATE_LIMIT_RESET_TOKEN` unlocks `POST /api/v1/_test/rate-limit/reset`, which empties every counter. It exists because the smoke test proves the guest limiter works by exhausting it, and the bucket it drains is address-keyed — the same bucket the next run needs.

Whoever holds that token can reset between bursts, which is **equivalent to having no rate limit at all**. A control with that reach cannot be governed by an operator's intention to keep it out of production, because the realistic failure is not somebody deciding to enable it — it is a `.env` copied from staging with one line nobody re-read. So:

- `loadConfig` **refuses to start** a production process that sets it. There is deliberately no override variable: an escape hatch with an escape hatch is a warning again.
- With no token, the route is never registered and the library's own counter store is used unchanged. Nothing in the resettable-store file is on any production code path.
- Every accepted reset logs at `warn` with the number of counters discarded.

The accepted cost: a production-`NODE_ENV` staging deployment cannot use it, and the smoke harness there falls back to waiting out the window it consumed. Slower and honest.

Proven by: `apps/api/test/rate-limit-isolation.test.ts`, including that `loadConfig` refuses the production case and that the route is absent without the token.

---

## 6. Authorisation and hidden information

**Authorisation lives in the `WHERE` clause**, not in a post-fetch check. A row that is not the caller's is never selected, so there is no window in which it exists in memory and might be serialised by mistake. A stranger's hand and a stranger's room both answer 404 rather than 403 — a 403 confirms the id exists, which is precisely what an enumerator wants.

**Hidden information is redacted by construction**, not by filtering (`docs/adr/0003`). A client view is *built* from a per-seat projection; there is no full-state object that gets fields deleted on the way out. That is what makes a leak a construction error rather than a missed filter, and it is why a new field on a view type is the thing to look at first in an incident.

Defended at four independent layers:

| Layer | What it stops |
| --- | --- |
| Projection per seat | hidden state never enters a client-facing object |
| Log redaction (three overlapping passes) | `holecards`, `deck`, `deckorder`, `salt`, `commitmentsalt` never reach a log line |
| Metric labels | no room, hand, user or session id exists as a label at all |
| Accessibility tree | a hidden card's accessible name must never state a rank or suit |

The fourth is not a formality. An accessible name is a real serialisation of state to a real consumer, and a card that leaks into it leaks to anyone.

Proven by: `apps/api/test/hidden-information-api.test.ts`, engine invariants and property tests, `scripts/smoke-test.mjs` hidden-info WebSocket scan, `scripts/ax-tree-audit.mjs`, and `pnpm run test:exhaustive`.

The deck commitment (`docs/adr/0004`) publishes a Merkle root up front and reveals the salt only **after** the hand, so a learner can verify the shuffle was not manipulated without the reveal ever being early. A reveal before the hand completes is a leak, and the timing check is the control.

---

## 7. Input validation and SQL

Every request body, query string and WebSocket frame is validated against a closed JSON Schema from `@prl/contracts`. Two deliberate departures from Fastify's defaults:

- `removeAdditional: false`. Fastify defaults to silently **deleting** unknown properties, which is safe against mass assignment and hides client bugs: a request with a misspelled field succeeds and does the wrong thing. The schemas are closed in order to *reject*, so rejection is what happens.
- `onProtoPoisoning` / `onConstructorPoisoning: 'error'`. A body containing `__proto__` is refused, not merged.

Router hardening: `maxParamLength: 64` (id patterns cap at 64, so anything longer is a bug or a probe) and `allowUnsafeRegex: false` (a backtracking route pattern is a denial of service in the router itself).

**Every query uses tagged-template parameterisation.** postgres.js sends the template text and its values as separate protocol fields, so a parameterised value can never become SQL syntax. There is no ORM escaping and no sanitiser behind it — that property *is* the defence. `.unsafe()` appears exactly once, in the migration runner executing a file from `db/migrations/` that contains no user input.

Bounds: 64 KiB request body, a 20 s request timeout, a per-statement Postgres timeout, an idle-in-transaction timeout, a bounded connection pool, a bounded worker queue, and message-size limits on WebSocket frames. Each is a place where an unbounded input would otherwise become the attack.

---

## 8. Database privileges

Three roles, and the separation is the control:

| Role | May |
| --- | --- |
| `prl_migrator` | own the schema and alter it |
| `prl_app` / `prl_api` | read and write rows; **not** alter the schema |

A compromised runtime credential is a data-read incident, not a schema-destruction one. Migrations run from **outside** the serving container, as `prl_migrator`, before the new application version starts.

`apps/api/scripts/verify-schema.mjs` asserts the shape rather than trusting it: column counts, index counts, specific constraints, object ownership and role privileges. It catches the case `migrate.mjs status` cannot — a migration recorded as applied whose effect is not actually present.

The `rooms_visibility_invite_only` CHECK constraint keeps public matchmaking off **at the database level**, so it cannot be turned on by an application change or an environment variable.

---

## 9. Secrets

Every operator-supplied secret is validated at boot for length (≥32 characters), distinct-character count (so a "long" secret is not a short one repeated), and placeholder substrings — `change`, `example`, `insecure`, `password`, `secret`, `default`, `todo`, `test` and the rest. A secret that ships in an example file is public knowledge the moment it is written down.

Secrets are injected externally, never baked into an image, never defaulted in a compose file. `.env` is gitignored and `security:hygiene` enforces it. Three overlapping log-redaction layers censor anything whose key name looks sensitive, and the censor string is a fixed literal so it is greppable.

Rotation procedures and their blast radii: [`runbooks/leaked-secret.md`](runbooks/leaked-secret.md).

---

## 10. Privacy and data minimisation

What is stored is deliberately thin:

| Table | Personal data |
| --- | --- |
| `users` | display name (learner-chosen); for federated accounts, issuer and subject |
| `sessions` | **digests only** — sha256 of the token, HMAC of the address and of the user agent. No raw address, no raw user agent, anywhere |
| `lesson_progress`, `quiz_attempts`, `scenario_attempts` | behavioural records |
| `hands`, `hand_seats` | hand history; the seat link is `ON DELETE SET NULL` so a hand survives its player's erasure |
| `audit_log` | security events, with sensitive keys redacted at write time |

Logs carry a **keyed hash** of the address rather than the address. Be honest about what that achieves: it is pseudonymisation, not anonymisation — anyone holding the secret can confirm a guessed address. What it buys is that a leaked log file, a screenshot or a support ticket does not hand out a list of addresses, while the value stays stable enough to rate-limit on. It is keyed rather than a plain hash because the IPv4 space is small enough to enumerate against an unkeyed one in seconds.

Metrics carry **no identifiers at all**, by construction, which is what makes it safe to scrape them into a long-retention store with weaker access control than the database.

Account deletion, the erasure policy and what is retained versus anonymised: the privacy policy page and [`runbooks/account-deletion-failure.md`](runbooks/account-deletion-failure.md).

---

## 11. Known residuals

Stated rather than closed. Each is a real limitation.

| # | Residual | Why it is accepted, and what bounds it |
| --- | --- | --- |
| 1 | `style-src-attr 'unsafe-inline'` | Confined to that directive. Permits style **attributes** only; no script execution, no inline `<style>`. Removing it means a class per computed value. |
| 2 | Development serves plaintext | Deliberate. HSTS off outside production so `localhost` is not pinned for a year. Production is TLS-only and the CSP is verified against a production-configured running image. |
| 3 | Client key is pseudonymous, not anonymous | Reversible by anyone holding the secret against a guessed address. The alternative — no stable key — means no address-based rate limiting. |
| 4 | Rate limiter state is per process | Two instances mean two budgets. Correct behaviour for a deployment where a table lives in one process; it does mean the published limit is per instance, not per deployment. |
| 5 | `skipOnError: true` on the limiter | If the counter store ever failed, requests are allowed rather than every call becoming a 500. The in-memory store cannot fail; the setting matters the day a shared store is introduced, and during such a failure there is effectively no rate limit. |
| 6 | Live table state is in-process | A crash mid-hand drops the hand. Accepted architecture (`docs/adr/0001`), not a hidden defect. |
| 7 | DB pool pressure is inferred, not measured | postgres.js exposes no wait counter; reaching into its internals would break silently on a patch release. Inferred from the timed readiness probe and verified by a drill. |
| 8 | Container base digests age | Pinned by digest, so they do not drift — which also means they do not receive upstream security rebuilds. A freshness check reports drift; acting on it is a deliberate bump. |
| 9 | OIDC flow not exercised in this environment | No identity provider is configured here. The code paths are unit-tested; the live flow is not verified. |
| 10 | Attributed AI Legend naming | `PRL_LEGEND_NAMING=attributed` must not be enabled without written legal review of name and likeness. Production default is `archetype`. |

---

## 12. Running the gates

```bash
pnpm run security:audit          # every supply-chain gate, release-blocking
pnpm run security:containers     # image CVE scan (trivy)
pnpm run security:sbom           # CycloneDX 1.6 for the current graph
pnpm run test                    # includes the security and hidden-information suites
pnpm run test:smoke --strict     # live headers, CSP nonce, hidden-info scan, rate limit
pnpm run test:ax                 # accessibility tree, including the hidden-card name check
pnpm run test:drills             # failure injection, including malformed WebSocket traffic
pnpm run verify                  # the whole gate list
```

A control is only as good as the last time its gate ran and failed for the right reason. Every guard test in this repository is required to carry a **negative control** — a case that feeds the detector a real violation and asserts it fires — because a guard whose failure mode has never been observed is decoration.
