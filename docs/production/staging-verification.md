# Staging verification

**Candidate SHA (images):** `b292b2ac234cb586f253ad42ec0ef4d949fa332b`
**Host log SHA:** `{SCRATCH}/staging.log` was stamped `c969163` because HEAD had moved to a docs-only commit when `staging up` started. The manifest it deployed is this SHA (`dirty=false`).

`{SCRATCH}`:
`/var/folders/7s/l9fr0tyd4wn9vp8qhg9yv7g80000gn/T/grok-goal-843cf6607006/implementer`

---

## Digests

| Service | Digest |
| --- | --- |
| api | `sha256:3854174f36184bb14cf2bf0b6912fbc199a804b230c392111c0a58943d92e36f` |
| web | `sha256:2bc457c546bf3b8edd379c610199b18f0c1b06ebc61bdb83183755df31a8bd88` |

Local BuildKit store. Not registry-attested.

---

## Proxy cert-refresh (348f75b + test)

`refreshStagingProxy` issues `compose up -d --force-recreate proxy` only. Tests drive that function with a fake compose runner (`scripts/staging.test.mjs`). `pnpm run test` on this SHA includes them.

Live `staging up` waited on `proxy:running/starting` after the stack `up`, then:

- running api/web containers match the manifest (`docker inspect`)
- `https://localhost:8443/api/v1/ready` **200** `{"status":"ready","checks":{"database":{"ok":true},"workers":{"ok":true}}}`
- HSTS `max-age=31536000; includeSubDomains`
- strict smoke **61 checks** including `__Host-prl_session` and `wss://`
- proxy overwrites `X-Forwarded-For` (24/24)
- `staging promote`: promotable, byte-identical

`STAGING_UP_EXIT=0`. `RATE_LIMIT_RESET_TOKEN` is absent (`NODE_ENV=production` refuses it).

---

## CVE

trivy HIGH floor, this SHA’s images: 0 blocking, 60 unfixable, 0 allowed (`containers.log`).

---

## Alerts

Metric families exist. `ApiDown`/`ApiNotReady` conditions were produced (drills 503; rollback 504). Staging compose has no Prometheus/Alertmanager. **Alert delivery UNVERIFIED.**
