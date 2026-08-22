# Staging verification

## Artifact identity

The local release manifest was built once from clean `4a17e3cec3a6418be34ee7b3efd69cbfe84446b2`:

| Service | Tag | Local BuildKit digest |
| --- | --- | --- |
| API | `prl-api:4a17e3cec3a6` | `sha256:9a8457e8ae427d64b7cd2aa4da65f2a978cc55ad347d1842c6822e8beba72abe` |
| Web | `prl-web:4a17e3cec3a6` | `sha256:34ba79323e2e0be06a7f935351401a3cc6ae8b9b1561e371d1cfa05263dccbb2` |

These are content-addressed local image-store values, not registry-attested values. No image was
pushed. The manifest records `commit.dirty=false` for `4a17e3c`.

The final candidate contains the staging-only certificate refresh fix (`348f75b` and later docs),
but the images were not rebuilt after it. The fix is not runtime application code, but the manifest is
not same-SHA provenance. Rebuild once from the final candidate before production promotion; do not
relabel these digests as final-SHA artifacts.

## Rehearsal

`pnpm run staging init -- --origin https://localhost:8443` generated loopback TLS and gitignored
secrets. The first `staging up` exposed a real defect: nginx had loaded the previous leaf and Compose
did not recreate an unchanged proxy after certificate renewal. `scripts/staging.mjs` now force-
recreates only the proxy, and `scripts/staging.test.mjs` guards that behavior.

Two post-fix bring-ups reused the exact manifest digests and passed:

| Check | Result |
| --- | --- |
| PostgreSQL healthy, roles/migrations applied | PASS |
| API/web running containers equal manifest by `docker inspect` | PASS |
| TLS `/api/v1/ready` | 200; database and workers ok |
| `/api/v1/health` | 200 |
| TLS chain against generated CA | PASS after proxy refresh |
| HSTS | `max-age=31536000; includeSubDomains` |
| Strict smoke over TLS including WebSocket | 61 checks, then 62 checks; PASS |
| Hidden-card/future-deck scan | PASS |
| Cookies/CORS/CSP/security headers | PASS in smoke |
| Forwarded-for overwrite | 24/24 forged addresses used the real bucket |

The smoke runs waited for the real guest limiter where necessary; no production limiter was weakened
and no reset token was used in the production-shaped stack.

## Unverified

External secret-manager injection, real production certificates/DNS, a registry pull, and alert
delivery are unavailable on this host. The Compose stack exports metrics and readiness conditions but
contains no Prometheus/Alertmanager/paging destination. Final promotion also requires a new manifest
from the final candidate SHA.
