# The heartbeat stopped

**You are reading this because something did not happen.**

Every other runbook in this directory is opened because an alert arrived. This one is opened
because one stopped: the `Watchdog` alert fires permanently and its notification is sent to a
watcher outside this deployment on a fixed interval, and that watcher has just told you the pings
have stopped.

Read this paragraph before anything else, because it changes what you can trust for the rest of
the page. **Nothing you can see from inside this deployment is evidence.** The pings stopped, so
whatever produces or delivers them is broken, and every alert in
[`../alerts.md`](../alerts.md) travels the same road. Assume the deployment has been unmonitored
since the last ping and that anything could have failed in that window without being reported.

---

## Symptoms

- The external watcher — Dead Man's Snitch, healthchecks.io, a PagerDuty or Grafana OnCall
  heartbeat integration, whatever `PRL_ALERT_HEARTBEAT_WEBHOOK_URL` points at — has alarmed on a
  missing check-in.
- Nothing at all has arrived from this deployment for longer than usual, on any channel.
- `AlertmanagerDown` or `AlertmanagerNotificationsFailing` fired *and then* went quiet.
- No page and no ticket has arrived during a window in which something visibly went wrong — a
  learner reported an outage, a dashboard was red, a deploy failed — which is
  [`alerting-blind.md`](alerting-blind.md)'s incident seen from the outside.

**The one symptom that is not this incident:** the watcher alarming immediately after a deliberate
redeploy of the observability stack. Prometheus and Alertmanager restarting stops the pings for as
long as they take to come back. If the gap matches a change somebody made, say so in the incident
channel and confirm the pings resumed rather than closing it silently — a real failure that begins
during a deploy is the easiest one in this file to dismiss.

## Detection

| Alert | Rule | Delivered to |
| --- | --- | --- |
| `Watchdog` | `vector(1)` — always firing | `PRL_ALERT_HEARTBEAT_WEBHOOK_URL`, every `PRL_ALERT_HEARTBEAT_INTERVAL` |

The rule is not the detector. **The detector is the service at that URL**, and it is deliberately
not in this repository: a watcher on this host dies with the host it is watching, and would report
nothing at exactly the moment it was needed. What is in this repository is everything on the
emitting side, and `pnpm run alerts:verify` check 7 proves all of it — the rule fires, it routes to
its own receiver and to neither human tier, the notifications keep arriving with measured gaps
inside the deadline, and with Alertmanager deliberately stopped the silence is detected while
Prometheus goes on reporting the same alerts firing to nobody.

### Why the silence means so much more than a page

Every other alert in this system reports a failure **by arriving**, so every other alert shares
one assumption: that the alerting system works. `AlertmanagerNotificationsFailing` and
`AlertmanagerDown` catch the partial cases — one receiver of two, one transport of two — and
[`alerting-blind.md`](alerting-blind.md) states plainly what they cannot catch: both paths broken
at once, because the channel carrying the report is the channel that failed.

The heartbeat is the only signal here whose report does not travel that channel. Its silence is
carried by a service that did not depend on anything that broke.

## Immediate containment

Containment is **restore human awareness**, exactly as in `alerting-blind.md`, and it comes before
diagnosis because until it is done every other incident in progress is invisible.

1. **Say in the team's channel that alerting is down and the deployment is being watched by
   people.** This one step is worth more than the rest of this page.
2. **Establish whether the application is even up**, from outside, without using anything in the
   monitoring stack:

   ```bash
   curl -sS -o /dev/null -w 'health %{http_code}\n' "$PUBLIC_ORIGIN/api/v1/health"
   curl -sS -o /dev/null -w 'ready  %{http_code}\n' "$PUBLIC_ORIGIN/api/v1/ready"
   ```

   A dead deployment and a dead monitoring stack produce the same silence, and they are very
   different incidents. Answer this before anything else.
3. **Bound the blind window.** The watcher knows when the last ping arrived; that timestamp is the
   start, and it is the only reliable one you have. Write it in the incident notes now — see
   [Escalation](#escalation) for what to do when it cannot be established.

## Diagnosis

Work outwards. The ping crosses four things, and each has a different fix.

### 1. Is Prometheus evaluating the rule at all

```bash
curl -sS "$PROM/api/v1/rules?type=alert" \
  | jq -r '.data.groups[].rules[] | select(.name=="Watchdog") | "\(.state) \(.health) \(.lastError // "")"'
```

`firing ok` is the only acceptable answer. `vector(1)` depends on no scrape, no metric and no
subsystem, so anything else means Prometheus itself is unwell or the rules file did not load —
`curl -sS "$PROM/api/v1/status/config"`. Nothing means Prometheus is not running, which is also the
answer to "why did the pings stop".

### 2. Is Alertmanager running, and did it accept the config

```bash
docker compose --env-file deploy/staging/.env.staging \
  -f docker-compose.staging.yml -f docker-compose.observability.yml ps alertmanager
curl -sS "$ALERTMANAGER/api/v2/status" | jq -r '.config.original' | grep -A 4 'name: heartbeat'
```

This is the most common cause, and `alerting-blind.md` § *Alertmanager is not running at all* has
the two usual reasons — a configuration it refuses to load, and a bind mount that resolved to a
directory because a generated file was removed.

### 3. Is the route still sending it to the heartbeat receiver

```bash
curl -sS "$ALERTMANAGER/api/v2/alerts" | jq -r '.[] | select(.labels.alertname=="Watchdog")
  | "\(.status.state)\t\(.receivers[].name)"'
```

`active heartbeat` is right. `active paging` or `active tickets` means the route was edited and the
heartbeat is now waking somebody every interval — fix it before the pager gets muted, and note that
`pnpm run alerts:verify` check 7 fails on exactly this.

**A `suppressed` state is the one to look hardest at.** Somebody silenced `Watchdog`, which is the
dead man's switch with the pin taped down: the alarm stops, everything looks healthy, and no
report of any kind can be made from inside this deployment again. Delete the silence.

```bash
curl -sS "$ALERTMANAGER/api/v2/silences" | jq -r '.[] | select(.status.state=="active")
  | "\(.id)\t\(.createdBy)\t\(.comment)"'
```

### 4. Can this deployment reach the watcher

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$PRL_ALERT_HEARTBEAT_WEBHOOK_URL"
```

A non-2xx or a timeout is egress: DNS, a firewall rule, an outbound proxy, or the snitch's own
outage. Alertmanager records the failure, and it records it as a notification failure like any
other:

```bash
curl -sS "$PROM/api/v1/query?query=alertmanager_notifications_failed_total" \
  | jq -r '.data.result[] | "\(.metric.integration)\t\(.value[1])"'
```

If the counter has moved for `webhook` and the human tiers are still delivering, this is a
heartbeat-only failure and the deployment is still monitored — a much smaller incident, and one
`AlertmanagerNotificationsFailing` would have paged you about in band.

### 5. The watcher itself

A snitch that was on a free tier that expired, a check that was deleted, or an account whose card
failed produces exactly this alarm and there is nothing wrong here at all. It is worth ruling out
early because it is cheap to check and embarrassing to discover late.

## Recovery

1. Fix the cause the section above named.
2. Confirm the pings resumed **at the watcher**, not here. The watcher going green is the whole of
   the recovery signal; anything observed from inside this deployment is the thing that was
   broken.
3. **Do not silence `Watchdog`, ever, for any reason.** There is no incident in which silencing it
   helps and there is one in which it is catastrophic. If its notifications are too frequent, raise
   `PRL_ALERT_HEARTBEAT_INTERVAL` and raise the watcher's grace period with it.
4. Work through everything that fired during the blind window. Prometheus kept evaluating even
   while nothing was delivered, so the record is complete even though the delivery was not:

   ```bash
   curl -sS --get "$PROM/api/v1/query_range" \
     --data-urlencode 'query=ALERTS{alertstate="firing"}' \
     --data-urlencode "start=$BLIND_START" --data-urlencode "end=$(date -u +%s)" \
     --data-urlencode 'step=60' | jq -r '.data.result[].metric.alertname' | sort -u
   ```

   If Prometheus itself was the thing that stopped, that record does not exist either and the
   window is genuinely unobserved. Say so in the incident notes rather than implying otherwise.

## Verification

Delivery is not restored because the watcher went green once. A single ping is exactly what a
heartbeat that has already failed looks like — a `repeat_interval` that Alertmanager rounded up, or
a receiver that fired at `group_wait` and never again, both produce one perfect-looking ping and
then nothing.

1. **Two consecutive intervals with no alarm at the watcher.** That is the smallest evidence of a
   rhythm rather than a one-off.
2. `pnpm run alerts:verify` against staging, which is the mechanism proven end to end including
   its own deliberate silence. `-- --only-heartbeat` runs checks 1–4 and 7 in about four minutes
   and does **not** stop the staging API.
3. If a human tier was also affected, `pnpm run alerts:ack` — a real page with a code in it that a
   person has to type back inside a bounded time. That is the only check in this repository whose
   pass condition is a human being awake.

## Escalation

- **The application was down during the blind window** — that incident is the escalation. Open its
  runbook; this one is now second priority.
- **The pings stopped and the deployment is fine** — this is a monitoring incident, not an outage,
  and it is still worth an hour today rather than a week from now. The next real failure is the
  one that goes unreported.
- **The blind window cannot be bounded** — if the watcher does not retain the last check-in time,
  record the window as unbounded rather than guessing. An assumed start time is how an unrelated
  incident gets closed as "nothing happened".
- **This has happened more than once for the same reason** — the fix is not in this runbook. Either
  the interval is too tight for the grace period, or the egress path to the watcher is not
  reliable, and both are configuration decisions rather than incidents.
- **Somebody silenced `Watchdog` to stop the noise** — that is a process problem, and it belongs in
  a retrospective rather than in a fix. The alerting system's own smoke detector was taken off the
  wall, and it will still be off the wall in three weeks.
