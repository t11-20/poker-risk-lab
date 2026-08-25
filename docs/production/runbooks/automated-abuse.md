# Automated abuse — credential stuffing, scripted callers, ban waves

Something is hitting the API faster or more persistently than a person does, and the limiter or the authentication path is what noticed.

Read [README.md](README.md) first. The rule that matters most here is rule 1: **never weaken a security control to restore service.** Both alerts in this file are the security controls *working*, and the tempting first move — raise a limit, widen a window, "temporarily" disable the limiter — is the one action that turns a contained incident into an uncontained one. A production process cannot even carry `RATE_LIMIT_RESET_TOKEN`; `config.ts` refuses to boot with it, precisely so this cannot be done under pressure.

---

## Symptoms

- Sign-in or session errors far above the background rate, usually with no learner reporting anything.
- 429s in the proxy log from a small number of callers, sustained past `Retry-After`.
- A single address or session producing more requests in a minute than a person could.
- Nothing else is wrong: hands complete, latency is flat, and the product works for everybody else.

## Detection

| Alert | Rule | Severity |
| --- | --- | --- |
| `AuthFailureSpike` | `sum(increase(prl_auth_failures_total[5m])) > 20` for 10 minutes | ticket |
| `RateLimitBans` | `sum(increase(prl_rate_limit_events_total{kind="banned"}[15m])) > 0` | ticket |

Both are tickets, and the reason is the same for both: **the control already refused the traffic.** Nothing is broken for a learner at the moment either fires, and there is nothing useful to do at 3am that cannot be done better at 9am with the audit log open. What escalates them is in §Escalation, and the two escalation paths are different.

The neighbouring alert that is **not** in this file: `AuthzFailureSpike` — *authenticated* callers being refused resources — is a page and goes to [hidden-card-incident.md](hidden-card-incident.md). The distinction is the whole reason the two counters are separate (`observability/metrics.ts`): failing to authenticate is somebody who cannot get in, and being refused a room you are authenticated for is somebody walking room and hand ids.

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_auth_failures_total|prl_authz_failures_total|prl_rate_limit_events_total'
```

`prl_rate_limit_events_total` carries a closed two-value `kind` label and both values are primed at zero from boot, so a rise from nothing is visible:

| `kind` | Meaning |
| --- | --- |
| `limited` | a 429 was returned. This is the limiter doing its job for an ordinary busy client and is **not** alerted on |
| `banned` | the caller went past `RATE_LIMIT_BAN_AFTER` beyond the limit while ignoring `Retry-After` — a script, not a person |

A ban is recorded **once per key per window**, not once per refused request (`plugins/security.ts`, `bansRecordedUntil`). So `increase(...{kind="banned"}[15m])` reads as *distinct callers banned*, and a value of 3 means three keys and not three requests.

## Immediate containment

**First: is it us?** Two of this repository's own tools provoke these alerts on purpose, and a self-inflicted ban is the most common cause of `RateLimitBans` on a staging or rehearsal deployment:

```bash
# `pnpm run test:smoke --strict` section 12 floods the guest limiter by design.
# `pnpm run alerts:verify` check 6 provokes RateLimitBans deliberately.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_rate_limit_events_total
```

If a smoke run or a verification run is in flight, or finished inside the last window, that is the alert and there is no incident. Say so in the ticket and stop — but confirm it from the timing rather than assuming it, because "it was probably the smoke test" is exactly what a real ban wave looks like to somebody who wants it to be nothing.

**Then: do nothing to the limiter.** Specifically, do not:

- Raise `RATE_LIMIT_MAX`, `RATE_LIMIT_GUEST_MAX` or `RATE_LIMIT_BAN_AFTER` "until the wave passes". A limit raised during an incident is a limit that stays raised.
- Set `RATE_LIMIT_RESET_TOKEN`. In production the process refuses to start with it, which is deliberate: the token empties the limiter, and for its holder that is equivalent to turning rate limiting off.
- Block at the edge on a whim. Address blocks punish everyone behind one NAT or one campus proxy — which is the exact reason the limiter keys on the *session* first and the hashed address only as a fallback.

Containment worth doing, in order of preference:

1. **Nothing.** The refusal is the containment. This is the usual correct answer for both alerts.
2. **Revoke the sessions being used**, if the callers hold genuine signed sessions (see §Diagnosis for how to tell). That removes their preferred bucket and drops them back to address keying.
3. **Shed at the edge** — a rate limit or a block in the proxy for a specific, identified source — only when the volume is affecting other learners. Check `prl_http_request_duration_seconds` and `prl_event_loop_delay_p99_seconds` before believing it is; a limiter refusing traffic cheaply usually is not.

## Diagnosis

### Which failure is it? The `reason` label is a closed set

`prl_auth_failures_total` is incremented for exactly three contract codes (`recordApiError` in `observability/metrics.ts`), and they mean very different things:

| `reason` | Almost always |
| --- | --- |
| `not_authenticated` | a caller with no session, or a client that stopped sending the cookie. Sustained and mixed with other reasons, it is a stuffing run |
| `session_expired` | a wave usually means sessions were invalidated *en masse* — the API restarted with a **generated** development secret, or `SESSION_COOKIE_SECRET` changed. That is a deploy fault, not an attack |
| `csrf_failed` | a client that stopped sending `x-csrf-token`, or a cookie the browser now rejects after a scheme or domain change. Also a deploy fault |

**One reason, starting at a deploy boundary, is a broken client. Mixed reasons, sustained, with no deploy near the onset, is automated.** Correlate the onset with `prl_process_start_time_seconds` before anything else:

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_process_start_time_seconds
```

### Is one thing being banned, or many?

The ban log line carries the bucket key, and the key's prefix answers the question that matters:

```bash
kubectl logs <pod> --since=1h | grep '"msg":"rate-limit ban threshold reached"'   # carries rateLimitKey
```

| Key prefix | Meaning |
| --- | --- |
| `s:` | the caller holds a **validly signed** session cookie, hashed. One key, one session — revoking it is available to you |
| `c:` | no valid session; the bucket is a keyed hash of the client address. A caller rotating garbage cookies lands here, which is the point |

A forged or foreign-signed cookie does not get its own bucket — the signature is checked *first*, and a caller cannot choose a fresh bucket by inventing a cookie. Measured before that was fixed: 60 requests with a rotating garbage cookie produced **zero** 429s against a configured limit of 3. If you are reasoning about "they can just rotate cookies", the bound is that each genuine cookie costs a `POST /auth/guest`, which is address-keyed at ten per minute.

Many distinct `c:` keys with the same behaviour is a distributed run, and that is the shape that escalates.

### The audit log

A ban is written to `prl.audit_log` as well as logged and counted, because it is the one rate-limit outcome that is a security event rather than traffic:

```bash
psql "$DATABASE_URL" -c "select created_at, event, detail from prl.audit_log \
  where event = 'security.rate_limit.banned' order by created_at desc limit 50"
```

`detail` carries the route and nothing that identifies a person — no address, no token, no user agent; the table's own `CHECK` constraint refuses a detail object containing any of them. The route distribution is the useful part: bans concentrated on `POST /api/v1/auth/guest` are somebody minting sessions, bans on `/api/v1/math/*` are somebody using this deployment as free compute, and bans spread evenly across the API are a scraper.

### Is anything actually degraded?

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_http_requests_total|prl_event_loop_delay_p99_seconds|prl_worker_pool_queued'
```

If the answer is no — and for a limiter that is refusing traffic it usually is — then this is a ticket about somebody trying, not an incident about the product.

## Recovery

| Cause | Action |
| --- | --- |
| This deployment's own smoke test or `alerts:verify` | none. Note it and close the ticket |
| One broken client (single `reason`, deploy boundary) | fix or roll back the client. → [rollback.md](rollback.md) |
| `session_expired` wave after a restart | confirm `SESSION_COOKIE_SECRET` is a real configured secret and stable across restarts. A generated development secret invalidates every session on every boot |
| `csrf_failed` wave | a client or cookie-attribute change. Same fix path as above; do not disable CSRF |
| One scripted caller, contained | none. The ban expires with its window. Record the route distribution |
| A caller holding genuine sessions | revoke those sessions; the limiter drops them to address keying |
| Distributed automated traffic affecting other learners | shed at the edge, then escalate — this is a security finding, not a capacity one |
| A legitimate integration that trips the limit | it is not legitimate at that rate. Talk to whoever runs it; changing the limit is a decision made in daylight, in a commit, with the number re-derived — not during an alert |

**Never** clear the ban state to "unstick" a caller. It expires on its own with the window, and there is no supported control that empties it in production for the reason above.

## Verification

```bash
# 1. Distinct callers banned has stopped rising. Sample twice, 15 minutes apart —
#    a counter that stopped and one still rising slowly look identical in one sample.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep 'prl_rate_limit_events_total'

# 2. Authentication failures are back to the background rate, by reason.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_auth_failures_total

# 3. The authorisation counter did NOT rise while this was happening. If it did,
#    the caller got in, and this stopped being a ticket. → hidden-card-incident.md
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_authz_failures_total

# 4. No new ban rows.
psql "$DATABASE_URL" -c "select count(*) from prl.audit_log \
  where event = 'security.rate_limit.banned' and created_at > now() - interval '30 minutes'"

# 5. Every control is still in place — the limiter refuses a flood, and a real
#    learner journey still works. Section 12 floods the guest limiter on purpose.
pnpm run test:smoke --strict
```

Step 5 is the one that counts, and it is the honest check on the whole of §Immediate containment: if a limit was widened during the incident, the smoke test's flood no longer produces the refusal it asserts, and this run says so.

## Escalation

Escalate when:

- `prl_authz_failures_total` rose during the window. An authenticated caller being refused resources is enumeration → [hidden-card-incident.md](hidden-card-incident.md), **at page severity**, regardless of what the limiter did.
- The bans are many distinct `c:` keys behaving identically. That is distributed and deliberate, and it belongs with the security owner rather than in an operations ticket.
- Any sign-in *succeeded* for an account the pattern was stuffing. Credentials are held by the identity provider, not here, but a compromised learner account is still a disclosure question → [leaked-secret.md](leaked-secret.md) for the credential half.
- Somebody has changed a limit, a window or the ban threshold to clear this incident. That is a control weakened under pressure, and it needs a second person and a reversal before the incident is closed.

Attach to the escalation: the counter samples with timestamps, the `reason` distribution, the ban key prefixes (never the keys themselves — they are keyed hashes of a session or an address and are not for pasting into a chat), the route distribution from the audit log, and the process start time.
