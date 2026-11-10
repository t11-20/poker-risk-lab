# Runbooks

One file per situation. **Most** have the same seven sections, in the same order — and the exceptions are named below, because `scripts/alert-delivery.mjs` rests its Detection-section check on this claim and a blanket "every one" is what let five files drift out of the shape without anybody noticing:

**Symptoms → Detection → Immediate containment → Diagnosis → Recovery → Verification → Escalation**

That order is the point. Containment comes before diagnosis because during an incident the instinct is to understand first, and understanding is slower than stopping the bleeding. Verification comes before escalation because "we fixed it" is a claim until something independent says so.

**Five files do not have that shape**, and knowing which is worth more than a claim that none exist:

| File | How it differs |
| --- | --- |
| `leaked-secret.md` | **no `## Detection` section at all** — it opens on "The secrets this system has, and what each one is worth" |
| `stuck-seat.md` | Symptoms, Detection, then four sections of its own; no Immediate containment / Diagnosis / Recovery / Verification / Escalation |
| `room-ownership-contended.md` | ten sections; Diagnosis is renamed, and there is a trailing "If it keeps happening" |
| `account-deletion-failure.md`, `public-origin-unreachable.md` | eight sections — one extra, ahead of Symptoms |

`scripts/alert-delivery.mjs` check 1 requires every rule's `runbook:` target to have a `## Detection` section that names the alert, so `leaked-secret.md` is only tolerated because no rule points at it.

## Index

| Runbook | Triggered by |
| --- | --- |
| [api-unhealthy.md](api-unhealthy.md) | `ApiDown`, `ProcessRestartLoop`, `HandsFailing`, `HandCompletionGap`, `TableActorFailing` |
| [public-origin-unreachable.md](public-origin-unreachable.md) | `PublicOriginDown`, `PublicOriginProbeDown`, `TlsCertificateExpiringSoon`, `TlsCertificateExpiryImminent` — the proxy, TLS and the page server: the layer every other alert here is blind to |
| [db-unavailable.md](db-unavailable.md) | `ApiNotReady` |
| [db-saturation.md](db-saturation.md) | `DbPoolSaturated`, `ArchiveFailing` |
| [room-ownership-contended.md](room-ownership-contended.md) | `RoomOwnershipFenced`, `RoomOwnershipRefused` — two API processes and one room |
| [stuck-seat.md](stuck-seat.md) | `SeatReleaseFailing` |
| [seat-entitlement-refused.md](seat-entitlement-refused.md) | `SeatEntitlementRefused`, `SeatNotRestored` — the enrolment guard turning people away, on a deployment running `PRL_ENROLMENT_REQUIRED=enforced` |
| [retention-sweep-stalled.md](retention-sweep-stalled.md) | `RetentionSweepStalled` — the scheduled deletion of expired rows and abandoned guest accounts has stopped |
| [websocket-spike.md](websocket-spike.md) | `WebSocketReconnectStorm`, `WebSocketConnectionsHigh`, `WebSocketRefusalSpike` |
| [worker-saturation.md](worker-saturation.md) | `EventLoopBlocked`, `WorkerPoolQueueDeep`, `AnalysisTimeouts` |
| [elevated-error-rate.md](elevated-error-rate.md) | `HttpErrorRateHigh`, `HttpLatencyP99High`, `HttpLatencyP95Degraded` |
| [automated-abuse.md](automated-abuse.md) | `AuthFailureSpike`, `RateLimitBans` — credential stuffing, scripted callers, ban waves |
| [metrics-cardinality-overflow.md](metrics-cardinality-overflow.md) | `MetricsCardinalityOverflow` — a metric folded into its overflow series and stopped being precise |
| [failed-migration.md](failed-migration.md) | a migration step that did not exit 0 |
| [failed-deployment.md](failed-deployment.md) | a deploy that did not reach a healthy state |
| [rollback.md](rollback.md) | the decision to go back to the previous digest |
| [backup-restore.md](backup-restore.md) | data loss, corruption, or a restore rehearsal |
| [account-deletion-failure.md](account-deletion-failure.md) | a learner's erasure request did not complete |
| [hidden-card-incident.md](hidden-card-incident.md) | `AuthzFailureSpike`, and any suspicion that hidden state reached a client. **Not** a hand that failed — see api-unhealthy.md |
| [incorrect-coach-result.md](incorrect-coach-result.md) | a reported wrong probability, EV or ranking |
| [leaked-secret.md](leaked-secret.md) | a credential is believed to be exposed |
| [dependency-compromise.md](dependency-compromise.md) | a malicious or compromised package |
| [unverified-image.md](unverified-image.md) | a release image whose signature does not verify |
| [alerting-blind.md](alerting-blind.md) | `AlertmanagerNotificationsFailing`, `AlertmanagerDown` — and any incident found by a person rather than by a page |
| [heartbeat-missing.md](heartbeat-missing.md) | `Watchdog` — the dead man's switch. The only runbook here opened because an alert **stopped**: the heartbeat this deployment sends to an external watcher has gone quiet |

## The index above is checked, and this is why

An alert's `runbook:` annotation in `deploy/staging/observability/alert-rules.yml` is what an operator actually follows at 3am, and for six of twenty-nine rules it pointed at a file that had never heard of the alert. The worst of them: `HandsFailing` — a **page**, whose own description says `interrupted_by_restart` after a deploy is expected once — opened `hidden-card-incident.md`, whose first instructions are to stop the affected surface, roll back to the last digest and wake the incident owner. An operator following that runbook would have rolled back production for a disclosure that was not happening.

`existsSync` on the annotation was the only check there had ever been, and a file existing is not a file about this alert. `alerts:verify` check 1 now also requires the annotated runbook to name its alert **in its Detection section** — a cross-reference elsewhere in the file does not count, because the Detection table is where somebody decided this runbook treats this alert. `scripts/alert-delivery.test.mjs` runs the same check without a container, so it fails in a pull request rather than in a release rehearsal.

So: **if you add an alert, add it to the Detection table of the runbook it opens, and to the index above.** The gate will tell you if you forget the first; nothing but this sentence will tell you about the second.

## Before you start, whatever the incident

Three facts change every decision below. Get them first; it takes under a minute.

```bash
# 1. Is the process alive, and is it in the load balancer?
curl -sS -o /dev/null -w 'health %{http_code}\n' "$API/api/v1/health"
curl -sS -o /dev/null -w 'ready  %{http_code}\n' "$API/api/v1/ready"

# 2. How long has this process been up? A recent start means a restart, and a restart
#    means the in-memory state of every live table was lost — see below.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep -E 'prl_process_start_time_seconds|prl_readiness_state|prl_rooms_live|prl_websocket_connections'

# 3. What is actually failing, by contract code rather than by status?
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_api_errors_total
```

## The one architectural fact that shapes every incident here

**Live table state is in-process.** A room being played is held in memory by exactly one API process (`docs/adr/0001-modular-monolith.md`, `docs/RUNBOOK.md` §11.1). Consequences you must hold in mind before touching anything:

- Restarting the API **drops every hand currently in progress.** Bot seats rehydrate from the database on the next start and rooms reopen, but the in-memory hand does not come back. This is an accepted architectural trade, not a bug — and it means "just restart it" is never free.
- Nothing is sharded or replicated at the table level. There is no failover for a table; there is only "the process that holds it".
- Hand history *is* durable, and archive writes are deliberately non-blocking: a failed write logs and play continues. So the database being unhappy degrades history, not gameplay.

Because of this, the containment step in most of these runbooks is **not** "restart". It is "stop new work reaching this instance" — readiness already does that automatically when the database is the problem.

## Severity, and who is woken

Defined in [`../alerts.md`](../alerts.md). Two tiers only: **page** (learners cannot use the product, chips or history are in an uncertain state, or a security control has failed) and **ticket** (degrading or contained). If you are reading a runbook at 3am and the situation is a ticket, the correct action is usually to write down what you saw and stop.

## Rules that apply to every incident

1. **Never weaken a security control to restore service.** Not the CSP, not the rate limit, not the origin allowlist, not the session cookie attributes. If a control is genuinely the cause, that is a finding to fix, not a switch to flip. A production process cannot even carry `RATE_LIMIT_RESET_TOKEN` — it refuses to boot — precisely so that this cannot be done under pressure.
2. **Never run a destructive database change to clear an incident.** Migrations are roll-forward only (`migrate.mjs` refuses `down`). See [rollback.md](rollback.md) for what that means in practice.
3. **Never enable public matchmaking.** It is off at the database level (`rooms_visibility_invite_only`), and no incident is a reason to change that.
4. **Record the request id.** Every error body carries `requestId`, echoed as `x-request-id`. It is the only thing that links a learner's report to a log line.
5. **Write the timeline as you go**, not afterwards. The reconstruction is always worse than the notes.
