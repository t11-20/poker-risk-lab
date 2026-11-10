# Leaked secret

A credential is believed to be exposed: committed, logged, screenshotted, shared, or otherwise outside the place it was meant to live.

Assume exposure means compromise. The cost of rotating a secret that was never actually seen is minutes; the cost of not rotating one that was is unbounded.

---

## Symptoms

- A secret appears in a commit, a log line, a ticket, a screenshot, a chat message, a CI log, or an error page.
- A secret-scanning tool fires.
- Unexplained authenticated activity, or sessions that should not exist.
- A third party reports finding one.

## The secrets this system has, and what each one is worth

| Secret | Guards | If exposed |
| --- | --- | --- |
| `SESSION_COOKIE_SECRET` | cookie signatures, the client-key HMAC, the rate-limit session hash | **Highest.** Forged session cookies, and the pseudonymous client key becomes reversible for any guessed address |
| `DATABASE_URL` credentials | everything stored | **Highest.** All learner data, read and write |
| `OIDC_CLIENT_SECRET` | the token exchange | sign-in impersonation, subject to the provider's own checks |
| `METRICS_TOKEN` | `GET /metrics` | route names, error rates, uptime, connection counts — reconnaissance, not data |
| `RATE_LIMIT_RESET_TOKEN` | the counter-reset control | effectively unlimited requests for the holder. **Cannot exist in production** — a production process carrying it refuses to boot |
| Registry / CI credentials | the supply chain | → [dependency-compromise.md](dependency-compromise.md) |

Note what is **not** on this list, because it changes the shape of this incident: there are no payment credentials, no real-money system and no cash-out path. The worst outcome is unauthorised access to learning data and forged sessions — serious, and bounded.

## Immediate containment

**Rotate first. Investigate second.** Every minute between exposure and rotation is a minute the credential works.

### `SESSION_COOKIE_SECRET`

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set it and restart. **Every existing session is invalidated** — every learner is signed out, including guests, and every in-flight cookie stops verifying. That is the intended effect: the same property that makes rotation disruptive is what makes it work.

Expect a reconnect wave immediately afterwards, with WebSocket closes at `4401`. That is not a second incident; see [websocket-spike.md](websocket-spike.md) if it does not settle.

Note the second consequence, which is easy to miss: the client key in the logs is `HMAC(secret, address)`, so rotating the secret **changes every client key**. Log correlation across the rotation boundary breaks. If an investigation depends on correlating before and after, record that boundary.

### `DATABASE_URL` / `DATABASE_MIGRATION_URL` credentials

```sql
ALTER ROLE prl_api      WITH PASSWORD '<new>';   -- DATABASE_URL, the runtime identity
ALTER ROLE prl_deployer WITH PASSWORD '<new>';   -- DATABASE_MIGRATION_URL, the migration identity
```

**`prl_app` is deliberately not on that list**, and this block used to name it instead of `prl_deployer`: `prl_app` and `prl_migrator` are `NOLOGIN` privilege containers created with no password (`db/migrations/0001_initial.sql`, `db/roles/0001_privilege_roles.sql`), so `ALTER ROLE prl_app WITH PASSWORD` rotated nothing while the login role that can alter the schema — `prl_deployer`, a member of `prl_migrator` — was left untouched. Rotate the identities that log in; the containers hold privileges, not credentials.

Update the environment and restart the API. Live connections keep working on the old credential until they recycle — `max_lifetime` is 1,800 s in `apps/api/src/db.ts` — so restart rather than waiting. If `DATABASE_MIGRATION_URL` was the leaked one, treat it as the more serious of the two: it reaches the schema and the migration ledger, which `prl_api` cannot.

Then check what the credential could have reached. The least-privilege split is the containment: `prl_app`/`prl_api` cannot alter the schema, and `prl_migrator` owns the objects. A leaked runtime credential is a data-read incident, not a schema-destruction one.

### `OIDC_CLIENT_SECRET`

Rotate at the identity provider first, then here. The four OIDC variables are all-or-nothing — three of four present is the dangerous state where the button appears and the exchange fails — so update them together. A partial configuration is refused at boot.

### `METRICS_TOKEN`

Rotate and restart. Lower urgency: the endpoint exposes shape and load, never learner data, and it carries no identifiers by construction.

### `RATE_LIMIT_RESET_TOKEN`

If this appears in a **production** environment at all, the process would have refused to start — so its presence means either it is in a non-production environment (rotate, low urgency) or somebody removed the refusal, which is a much more serious finding than the token itself.

## Diagnosis

### Bound the exposure window

```bash
# Committed? Search the whole history, not just the working tree.
git log --all -p -S '<distinctive fragment>' -- . | head -60
git log --all --oneline --since='<date>' -- .env .env.example
```

`.env` is gitignored and `security:hygiene` enforces repo hygiene, so a committed secret means a gate was bypassed — worth knowing on its own.

```bash
# Logged? Three redaction layers should make this impossible; verify rather than assume.
kubectl logs <pod> --since=168h | grep -Ei '(secret|token|password|database_url)' | grep -v '\[redacted\]'
```

Finding the key name with `[redacted]` is the system working. Finding a real value means a redaction gap, which is a second defect to fix in `apps/api/src/logging.ts` — and the fix is at the key-name layer, so the *next* secret with that name is caught too.

### Establish whether it was used

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_auth_failures_total|prl_authz_failures_total|prl_rate_limit_events_total'
```

- Forged sessions would show as *successful* requests, not failures — so the absence of `prl_auth_failures_total` is not reassurance.
- `prl_authz_failures_total` rising is somebody with a valid session probing for other people's rooms and hands → [hidden-card-incident.md](hidden-card-incident.md).
- The audit log (`prl.audit_log`) records guest creation, session revocation, refused upgrades and rate-limit bans. Query it for the window.
- For a database credential, `pg_stat_activity` and the server log show connections; an `application_name` other than `poker-risk-lab-api` is a strong signal.

## Recovery

1. Rotate, as above. Rotate **every** secret sharing the exposure — a leaked `.env` is not one secret.
2. Fix the leak path: the gitignore, the log redaction, the CI masking, the screenshot habit. A rotation without this is a rehearsal for the next one.
3. Purge where feasible, and be honest that it is partial. A committed secret is in every clone and every fork; history rewriting does not reach those. Rotation is the control, not deletion.
4. Revoke derived access. For `SESSION_COOKIE_SECRET` the restart does it. For a database credential, terminate live backends with `pg_terminate_backend` after the password change.
5. Add a detection for that shape of secret if none fired.

## Verification

```bash
# 1. The old secret no longer works. For the session secret, an old cookie must be rejected.
curl -sS -o /dev/null -w '%{http_code}\n' -H "Cookie: prl_session=<old signed value>" "$API/api/v1/auth/session"

# 2. The new configuration is in force and the process is healthy.
curl -fsS "$API/api/v1/health" && curl -fsS "$API/api/v1/ready"

# 3. Repo hygiene and the supply-chain gates pass.
pnpm run security:hygiene
pnpm run security:audit

# 4. No secret is reachable in logs or metrics. Both must print nothing.
kubectl logs <pod> --since=1h | grep -Ei '(secret|token|password|database_url)' | grep -v '\[redacted\]'
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -Ei 'secret|token|password'

# 5. A real journey works with new sessions.
pnpm run test:smoke --strict
```

Point 1 is the one people skip. Rotating a secret and confirming the *new* one works proves nothing about whether the old one stopped working.

## Escalation

Escalate when:

- `SESSION_COOKIE_SECRET` or a database credential was exposed for more than a moment, or you cannot bound the window.
- There is any evidence of use: unexplained sessions, `prl_authz_failures_total` rising, unfamiliar `application_name` values on database connections.
- The secret reached anywhere public — a public repository, a public CI log, a public ticket.
- Learner data may have been read. That is a privacy matter with obligations beyond engineering, and the data inventory in the privacy policy is the reference for what could have been reached.
- The leak path is a control that should have stopped it. A bypassed gate is a bigger finding than the secret.

The incident record must state: which secrets, the exposure window, how it happened, whether use was detected or only possible, what was rotated and when, and what now prevents recurrence. Do not write "no evidence of use" without saying what you actually looked at.
