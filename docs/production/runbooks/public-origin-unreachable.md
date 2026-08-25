# The public origin is unreachable

A learner opening the site gets nothing, or gets something that is not the product — and the application may be perfectly healthy behind it. This runbook is for the layer between a browser and the API: DNS, the published port, the proxy, TLS, and the page server.

Read [README.md](README.md) first.

---

## The blind spot this closes, and why it needs saying

Every other alert in this system reads a series the API exports **about itself**, and Prometheus scrapes the API directly, on the internal network, bypassing the proxy. The API's healthcheck targets its own container. So before the probe existed, a total user-facing outage looked like this:

| What broke | What the alerts said |
| --- | --- |
| nginx dead | `up{job="prl-api"}` = 1, `prl_readiness_state` = 1, counters flat. **Nothing fired.** |
| TLS certificate expired | as above. **Nothing fired.** |
| The Next.js page server dead | as above. **Nothing fired.** |
| DNS or the edge misconfigured | as above. **Nothing fired.** |

Request counters going flat is not a signal here and a rule on it would be a mistake: this is a teaching lab, and a night with no traffic is the healthy overnight state. So the signal is synthetic — a real request, through the front door, every 15 seconds, made by a blackbox probe. When it stops working, something a learner would have hit is broken.

**If you are reading this because a learner reported a dead site and no alert fired, that is a finding.** Check that the probe is running before anything else (§Diagnosis, step 0): a probe that is not running looks exactly like the old blind spot.

## Symptoms

- The site does not load. Connection refused, a TLS warning, a browser error page, or an nginx error page.
- Learners report "the site is down" while `/metrics`, the logs and every dashboard look normal.
- A certificate warning in the browser, or `curl` refusing the chain.

## Detection

| Alert | Rule | Severity |
| --- | --- | --- |
| `PublicOriginDown` | `probe_success{job="prl-public-origin"} == 0` for 2 minutes | page |
| `PublicOriginProbeDown` | `up{job="prl-public-origin"} == 0` for 10 minutes | ticket |
| `TlsCertificateExpiringSoon` | earliest certificate expiry under 21 days | ticket |
| `TlsCertificateExpiryImminent` | earliest certificate expiry under 3 days | page |

Two labels do most of the triage before you type anything:

| Label | Values | What it tells you |
| --- | --- | --- |
| `instance` | the probed URL | which front-door path failed |
| `module` | `learner_page_https`, `api_health_https` | which upstream was being reached through the proxy |

| `learner_page_https` | `api_health_https` | Almost certainly |
| --- | --- | --- |
| fail | fail | the proxy, TLS, or the host — nothing is getting in |
| fail | pass | the **page server**: nginx and TLS are fine, `/` is not being served → [api-unhealthy.md](api-unhealthy.md) is the wrong file; this is the `web` service |
| pass | fail | the **API through the proxy**. If `ApiDown` is silent, the API is up and the `/api/` route is broken; if `ApiDown` is firing too, the API is the fault → [api-unhealthy.md](api-unhealthy.md) |
| pass | pass with `TlsCertificate…` firing | nothing is down yet. The site goes dark at a known minute unless the certificate is renewed |

`PublicOriginDown` is a **page** and the other availability alerts are too, so the tie-breaker is which one to open: if `ApiDown` and `PublicOriginDown` fire together, the API is the cause and the probe is a symptom — go to [api-unhealthy.md](api-unhealthy.md). `PublicOriginDown` **alone** is this file, and it is the case nothing used to catch.

### What the probe does not cover

The probe runs beside the deployment and enters the proxy on the internal network. It therefore proves the proxy, the TLS handshake, the certificate, the routing and both upstreams — and it proves **nothing** about:

- **DNS** for the public name;
- **the published port** and anything that forwards to it;
- **a firewall or a security group** between a learner and the host.

Those three are the reason step 1 below is done from a machine that is not the host. A green probe with a dead site is exactly this class of fault, and it is the one shape of outage that still needs a human to notice.

## Immediate containment

There is nothing to contain in the usual sense — the product is not corrupting anything, it is unreachable. The job is to restore reach, and the order matters because the cheap non-destructive checks are also the most likely causes:

1. **Do not restart the API.** It is very probably healthy, and restarting it drops every hand in progress (README, "live table state is in-process"). `PublicOriginDown` on its own is *evidence that the API is fine*: the probe reached the API's own liveness route through the proxy in the `api_health_https` module, or `ApiDown` would be firing as well.
2. **Do not regenerate certificates or reissue anything under pressure** before reading §Diagnosis. An expired certificate has a fix that takes a minute; a wrongly reissued chain takes a browser cache and a support queue to undo.
3. **If a deploy is in flight, stop it.** A proxy configuration change is the most common cause of this alert on an otherwise healthy stack.

## Diagnosis

### 0. Is the probe itself alive?

```bash
# The probe's own scrape target. If this is 0, the probe is not running and the
# origin is UNWATCHED — which is not the same as the origin being down.
curl -sS 'http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22prl-public-origin%22%7D'
```

`PublicOriginProbeDown` is the alert for that case and it is a ticket, because a probe that stopped is a monitoring failure rather than an outage — but treat it with urgency anyway: while it is down, the failure it exists to catch fires nothing.

### 1. From OUTSIDE the host, before anything else

The three things the probe cannot see are all here, and this takes ten seconds:

```bash
# From a laptop that is not the deployment host. Substitute the real origin.
dig +short <public hostname>
curl -sS -o /dev/null -w 'status %{http_code}  tls %{ssl_verify_result}  time %{time_total}s\n' https://<origin>/
openssl s_client -connect <host>:<port> -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -dates -subject -issuer
```

- **`dig` returns nothing or the wrong address** → DNS. Nothing on the host will fix it.
- **Connection refused / times out** but the probe is green → the published port, a firewall, or a security group.
- **A certificate error** → §TLS below.

### 2. On the host: is the proxy up, and what is it saying?

```bash
docker compose --env-file deploy/staging/.env.staging -f docker-compose.staging.yml ps proxy
docker compose --env-file deploy/staging/.env.staging -f docker-compose.staging.yml logs --tail=50 proxy
```

nginx refuses to start on a bad configuration and says which line. Two failures specific to this deployment:

- **Unreadable TLS material.** The proxy mounts `deploy/staging/tls` read-only and runs as uid 101 with `cap_drop: ALL`. A key regenerated with the wrong ownership or mode stops nginx at startup, and the log line names the file.
- **A missing mount resolving to a directory.** Docker creates a *directory* for a bind mount whose source does not exist, so a deleted `staging-chain.pem` becomes "is a directory" rather than "not found". That has cost an hour elsewhere in this repository already.

### 3. Which upstream is missing?

The proxy answers on its own; the 502 comes from behind it.

```bash
# From the host, with the CA the staging chain is issued by.
curl -sS --cacert deploy/staging/tls/staging-ca.pem -o /dev/null -w '/ %{http_code}\n' https://localhost:8443/
curl -sS --cacert deploy/staging/tls/staging-ca.pem -o /dev/null -w 'health %{http_code}\n' https://localhost:8443/api/v1/health
```

| Result | Meaning |
| --- | --- |
| both 200 | the origin is fine from the host — go back to step 1; the fault is between a learner and this machine |
| `/` is 502, health is 200 | the `web` service. Check its health and logs; the API is fine and needs nothing |
| `/` is 200, health is 502 | the `/api/` route or the API. Check `ApiDown` → [api-unhealthy.md](api-unhealthy.md) |
| both 502 | both upstreams, or the proxy cannot resolve them — a network or a compose-level fault |
| connection refused | the proxy is not listening. Step 2 |

### TLS

```bash
# What the origin is actually serving, and until when.
openssl s_client -connect localhost:8443 -servername localhost </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName

# What the probe sees, as a Unix timestamp. This is the series the two TLS alerts read.
curl -sS 'http://127.0.0.1:9090/api/v1/query?query=probe_ssl_earliest_cert_expiry'
```

Three distinct faults look similar in a browser and are not similar at all:

| Fault | Evidence | Fix |
| --- | --- | --- |
| **Expired** | `notAfter` in the past | renew. In staging: `pnpm run staging init` regenerates the leaf and can do it while the stack is up. In production, whatever issues the real certificate |
| **Wrong name** | the SANs do not contain the hostname a learner uses | reissue for the right name. `staging init --origin <url>` writes the SANs from the origin |
| **Incomplete chain** | the leaf verifies locally but not from elsewhere | the proxy must serve the **chain**, not the bare leaf — `ssl_certificate` points at `staging-chain.pem` for exactly this reason |

The staging leaf is deliberately **90 days**, not ten years: "a staging certificate that never expires is a staging certificate whose renewal has never been rehearsed" (`scripts/staging.mjs`). `pnpm run staging status` warns as it approaches — but only when somebody runs it, which is why the probe's expiry series is what the alerts read.

## Recovery

| Cause | Action |
| --- | --- |
| DNS | fix the record; nothing on the host is wrong. Note the TTL — the outage outlives the fix by it |
| Firewall / security group / port publishing | restore the path. Verify from off the host, not from it |
| nginx down on a bad config | fix the config and start it. The container is stateless; restarting the **proxy** costs nothing and drops no hands — unlike restarting the API |
| Unreadable TLS material | restore ownership and mode, then start the proxy. `pnpm run staging init` regenerates the whole set in staging |
| Certificate expired or wrong | renew or reissue, then restart the proxy so it loads the new file. nginx does not re-read certificates on its own |
| The `web` service is down | restart **that** service. It holds no game state, so it is the one application container that is cheap to restart |
| The API is down | [api-unhealthy.md](api-unhealthy.md). Do not treat it here |
| A bad deploy of the proxy config | [rollback.md](rollback.md) |

If the fix was a certificate, record the new expiry date somewhere a person will see before the alert does. Two renewals with the same missing calendar entry is how the second outage happens.

## Verification

```bash
# 1. The probe says the origin is answering, from the probe's own view.
curl -sS 'http://127.0.0.1:9090/api/v1/query?query=probe_success'
#    Expect 1 for every instance, both modules.

# 2. Certificate expiry is far away and is the certificate you just installed.
curl -sS 'http://127.0.0.1:9090/api/v1/query?query=probe_ssl_earliest_cert_expiry'
openssl s_client -connect localhost:8443 -servername localhost </dev/null 2>/dev/null \
  | openssl x509 -noout -dates

# 3. From OUTSIDE the host — the half the probe cannot answer.
curl -sS -o /dev/null -w 'status %{http_code} tls %{ssl_verify_result}\n' https://<origin>/

# 4. A learner's journey end to end, over TLS, against the deployed images.
pnpm run test:smoke --strict
```

Step 4 is the one that counts, and it is the same tool that made this gap visible: it checks the public origin over TLS with the CA, in 72 checks — **once, at deploy time**. The probe is what turns that single measurement into a continuous one; the smoke run is what proves the product behind the origin still works.

## Escalation

Escalate when:

- The origin is unreachable from outside and everything on the host is green. That is DNS, the network or the edge, and it is owned by whoever owns the domain.
- A certificate cannot be renewed in time. The site goes dark at a known minute, so this becomes a scheduled outage with a deadline — say so, in advance, rather than discovering it at the minute.
- `PublicOriginProbeDown` has been firing for longer than it takes to fix. The origin is unwatched and the failure it catches is silent.
- The probe is green, the smoke test passes, and learners still cannot reach the site. Something between them and this deployment is failing in a way nothing here can see, and the next evidence has to come from a learner's network.
