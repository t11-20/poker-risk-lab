# Staging verification

**Candidate SHA (images):** `68394b3df5dc51f45fa7409a3541c224861dad49`

> **Superseded.** Everything below describes the `b292b2a` candidate on Debian bookworm-slim.
> The current candidate is `68394b3`, on `node:24.18.0-alpine3.24`, whose scan reports **zero**
> findings of any severity — the CVE section below is history, not a live figure. Its staging run
> passed 62 strict-smoke checks with the proxy as the single source of HSTS. See
> [`final-readiness-report.md`](final-readiness-report.md).

**Previous candidate SHA (images):** `b292b2ac234cb586f253ad42ec0ef4d949fa332b`
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

trivy HIGH floor, this SHA’s images: **0 blocking, 60 unfixable, 0 allowed**. Re-scanned at
UTC 2026-08-24T16:15:22Z with trivy 0.72.0 against the same two digests: still 0 blocking.

The 60 is **not** 60 HIGH, which is how both release reviews recorded it. It is **52 HIGH and
8 CRITICAL**, 30 findings per image, 14 distinct CVEs — the images are the same Debian 12.15
base, so each finding appears twice:

| Severity | Distinct CVEs | Notable |
| --- | --- | --- |
| CRITICAL | 4 | `CVE-2023-45853` zlib1g (`will_not_fix`), `CVE-2026-13221` / `CVE-2026-42496` / `CVE-2026-8376` perl-base |
| HIGH | 10 | `CVE-2026-53613` / `CVE-2026-53615` util-linux family (8 packages each), ncurses, gzip, libacl1, perl-base |

`container-scan.mjs` now prints that breakdown and names the unfixed CRITICALs on their own
line, because "60 unfixable HIGH" and "8 CRITICAL among 60" are different facts to somebody
deciding whether to ship. The policy is unchanged and is deliberate: a finding with no
available fix does not block, because the only remediation is a different base image and a
permanently red gate is a gate somebody turns off. `--include-unfixed` makes them block, and a
review that runs it is measuring a different policy from the one this repository ships — which
is the whole of the disagreement between the two reviews on this point.

---

## Alerts

**Was:** metric families exist, `ApiDown`/`ApiNotReady` conditions were produced (drills 503;
rollback 504), staging compose has no Prometheus/Alertmanager — **alert delivery UNVERIFIED**.

**Now:** `pnpm run alerts:verify`, against this same running stack, **16 of 16 checks, exit 0**
(`alert-delivery2.log` / `.json`, stamped `SHA=5e3cbbc`, UTC 2026-08-24T16:50:52Z). The application
images under test are still the candidate digests above; the overlay adds only Prometheus
(`v3.7.3`) and Alertmanager (`v0.28.1`), both pinned by digest in
`docker-compose.observability.yml`.

| Check | Result |
| --- | --- |
| All 22 rules loaded, no evaluation error | PASS |
| Every rule is `page` or `ticket` | PASS — 10 page, 12 ticket |
| Every `runbook` annotation resolves to a file | PASS |
| Rules file and `alerts.md` name the same 22 alerts, same severities | PASS |
| Every `prl_*` series the rules name is in a live scrape | PASS — 38 metric families |
| Every expression evaluates against live data | PASS — 22 expressions |
| `ApiDown` provoked: `compose stop api` → firing | PASS — 248 s after the stop |
| Alertmanager received it | PASS — same second |
| Paging receiver notified | PASS — 4 s later, on `/page` |
| The page did **not** also raise a ticket | PASS — severity routing enforced |
| API restored, resolved notification delivered | PASS — healthy in 11 s, resolved 18 s later |

The 248 s is not slack: `max_over_time(up[2m]) == 0` cannot be true until two minutes of failed
scrapes have accumulated, and only then does `for: 2m` begin. A first run of this verification
used a four-minute budget and reported a false negative on a rule that was working — the
budget is now six.

**Still unverified:** that a human is reached — but the boundary has moved a long way in. Both
tiers are now delivered over **two transports**: an HTTP webhook and a real SMTP transaction, with
Alertmanager handing ~10 KB of RFC822 to a sink whose envelope recipient is the address the tier's
routing chose. Destinations are rendered from `alertmanager.template.yml` at bring-up rather than
edited, so the file Alertmanager loads does not exist in a clean checkout. What remains unproven is
that a provider accepts real credentials (the sink negotiates no TLS and asks for no AUTH), that
the address is one a phone watches, and that anybody is awake. Twenty of the twenty-two rules were
checked but not provoked; `ApiDown` and `RateLimitBans` are driven end to end.
