# The alerting system itself cannot deliver

Alerts are firing, or would be, and nobody is being told. This is the one incident whose own
report is the thing that is broken.

Read the next paragraph before doing anything else, because it changes what you can trust for the
rest of this runbook.

**If you are reading this because you were paged, one delivery path still works.** That is
already the most useful fact you have: the failure is partial. `AlertmanagerNotificationsFailing`
reached you, so whatever integration is broken is not the one that reached you.

**If you are reading this because somebody noticed by hand — a learner reported an outage, a
dashboard was red, a scheduled check went quiet — assume nothing was delivered.** Every alert
listed in [`../alerts.md`](../alerts.md) may have fired at any point since the failure began, and
none of them is in anybody's inbox. Start at [Immediate containment](#immediate-containment)
rather than at diagnosis, and treat the deployment as having been unmonitored for an unknown
period.

---

## Symptoms

- `AlertmanagerNotificationsFailing` fires: `alertmanager_notifications_failed_total` has moved.
- `AlertmanagerDown` fires: Prometheus cannot scrape Alertmanager at all.
- Neither fires and nothing has arrived for days — which is either a genuinely quiet week or this
  incident, and from inside the deployment those two look identical. See
  [The case these rules cannot report](#the-case-these-rules-cannot-report).
- An incident was found by a person rather than by a page.
- Alertmanager's own UI (`http://127.0.0.1:9093` on the staging overlay) shows alerts in
  **Firing** that nobody was told about.

## Detection

| Alert | Rule |
| --- | --- |
| `AlertmanagerNotificationsFailing` | `sum(increase(alertmanager_notifications_failed_total[15m])) > 0` |
| `AlertmanagerDown` | `absent(up{job="prl-alertmanager"}) or max_over_time(up{job="prl-alertmanager"}[2m]) == 0` |

Both are **pages**, and the reason is the asymmetry rather than the severity. A broken receiver is
usually one receiver: a ticket queue that has stopped accepting notifications can still be reported
through the paging path, and a broken pager can still raise a ticket. Making both `page` means the
report goes down whichever path still works.

`alertmanager_notifications_failed_total` is scraped by the `prl-alertmanager` job in
`deploy/staging/observability/prometheus.yml`. Until that job existed the counter was exported by a
container on the network and read by nothing — an expired provider key would have incremented it
forever while every dashboard stayed green.

### The case these rules cannot report

**Both paths broken at once.** If Alertmanager cannot deliver anything, it cannot deliver the news
that it cannot deliver anything; if it is not running, Prometheus has nowhere to send
`AlertmanagerDown` either. No in-band alert can close this, and no amount of extra rules will —
the channel carrying the report is the channel that failed.

What closes it is a check that runs **outside** this deployment and complains when it stops hearing
from it — and that is now shipped, in the half that can be:

- **A dead man's switch.** `Watchdog` (`expr: vector(1)`) fires permanently and is routed to a
  third receiver, `heartbeat`, whose destination is `PRL_ALERT_HEARTBEAT_WEBHOOK_URL` — the ping
  URL of a service outside this deployment that alarms when the pings stop. See
  [`heartbeat-missing.md`](heartbeat-missing.md), the runbook opened when this alert **stops**.

  *This runbook used to say the repository shipped no such rule, on the grounds that the watching
  half is by definition not in the repository and shipping the firing half alone would be a rule
  that pages nobody about a service nobody watches. That objection is answered rather than
  ignored: `pnpm run alerts:preflight` **refuses to promote a release** whose heartbeat URL is
  still a placeholder or still names the rehearsal machine, so the firing half cannot ship
  alone. `pnpm run alerts:verify` check 7 proves everything on this side of that URL — the rule
  fires, it routes to neither human tier, the pings keep arriving with measured gaps inside the
  grace period, and with Alertmanager deliberately stopped the silence is detected while
  Prometheus goes on reporting the same alerts firing to nobody.*

  What remains external is the watcher itself, and irreducibly so: a watcher on this host dies
  with the host it is watching.
- **A scheduled human check.** Somebody runs `pnpm run alerts:preflight -- --handshake` on a
  calendar, and `pnpm run alerts:ack` to send a real test page that a person has to acknowledge
  with a code inside a bounded window. Cheaper than a snitch, less reliable, and it is the only
  check here whose pass condition is a human being awake.

This runbook's honest position is unchanged in one respect: the total case is **detected by
something outside this deployment**, and everything below is written for someone who has arrived by
that route.

## Immediate containment

Containment here is not "fix Alertmanager". It is **restore human awareness first**, because until
that is done every other incident in progress is invisible.

1. **Say out loud, in whatever channel the team uses, that alerting is down.** From this moment
   until it is fixed, the deployment is being watched by people rather than by machines. This one
   step is worth more than the rest of this runbook.
2. **Look at what is currently firing, directly**, bypassing delivery entirely:

   ```bash
   # Every alert Prometheus currently considers firing, whether or not it was delivered.
   curl -sS "$PROM/api/v1/alerts" | jq -r '.data.alerts[] | "\(.labels.severity)\t\(.labels.alertname)\t\(.state)"'

   # And what Alertmanager thinks it is holding.
   curl -sS "$ALERTMANAGER/api/v2/alerts" | jq -r '.[] | "\(.labels.alertname)\t\(.status.state)"'
   ```

   Anything `page` in that first list is an incident that has been running unattended. Handle it
   with its own runbook before continuing here.
3. **Assume nothing was delivered for the whole window.** Take the time
   `alertmanager_notifications_failed_total` first moved, or the time Alertmanager last answered a
   scrape, whichever is earlier, as the start.

## Diagnosis

### Which integration is failing

```bash
curl -sS "$PROM/api/v1/query?query=alertmanager_notifications_failed_total" \
  | jq -r '.data.result[] | "\(.metric.integration)\t\(.value[1])"'
```

The `integration` label is `webhook` or `email`. That single label usually names the fix:

| Integration failing | Almost always |
| --- | --- |
| `email` only | The relay rejected the credential or the sender. A rotated `PRL_ALERT_SMTP_PASSWORD`, an SMTP username that was disabled, or a `PRL_ALERT_EMAIL_FROM` on a domain the relay no longer accepts. |
| `webhook` only | The provider's intake URL changed, its key expired, or it is answering a non-2xx that Alertmanager records as a failure. |
| both | Egress. DNS, a firewall rule, or an outbound proxy — the two integrations share nothing else. |

### What the relay actually said

Alertmanager logs the reason and it is the fastest answer in this file:

```bash
docker compose --env-file deploy/staging/.env.staging \
  -f docker-compose.staging.yml -f docker-compose.observability.yml \
  logs --tail 200 alertmanager | grep -iE 'notify|error|failed'
```

A `535` is a credential. A `550` is the sender or the recipient. A connection refused or a timeout
is the network. A 4xx from a webhook is the provider.

### Is the configuration even what you think it is

`deploy/staging/observability/alertmanager.yml` is **generated** — it is rendered from
`alertmanager.template.yml` by `scripts/alert-delivery.mjs` and deleted at the end of every
verification run. Editing it fixes nothing that survives. Ask the running process what it loaded:

```bash
curl -sS "$ALERTMANAGER/api/v2/status" | jq -r '.config.original'
```

Webhook URLs read back as `<secret>` — Alertmanager types them as secrets and redacts them from
every API — so a wrong URL is not visible here. The email recipients and the smarthost are.

Then check the values a promotion would be judged on:

```bash
pnpm run alerts:preflight                 # placeholders, shapes, both tiers, credentials
pnpm run alerts:preflight -- --handshake  # and whether the relay accepts the credential today
```

The handshake stops at `AUTH` — no `MAIL FROM`, no `RCPT TO`, no `DATA` — so running it during an
incident cannot send anybody a message.

### Alertmanager is not running at all

```bash
docker compose --env-file deploy/staging/.env.staging \
  -f docker-compose.staging.yml -f docker-compose.observability.yml ps alertmanager
```

The overwhelmingly common cause is a configuration it refuses to load, and the second most common
is a bind mount that resolved to a directory: Docker creates a **directory** for a missing mount
source, and both `alertmanager.yml` and `smtp-password` are generated files that are removed after
each verification run. Alertmanager then reports unreadable configuration rather than a missing
file. `node scripts/alert-delivery.mjs --render-config` writes both again.

## Recovery

1. Fix the cause the `integration` label named — rotate the credential, correct the URL, open the
   egress path.
2. Re-render and restart Alertmanager so it loads the corrected configuration:

   ```bash
   node scripts/alert-delivery.mjs --render-config
   docker compose --env-file deploy/staging/.env.staging \
     -f docker-compose.staging.yml -f docker-compose.observability.yml \
     up -d --force-recreate alertmanager
   ```

3. **Do not silence the alert to make it stop.** A silence on
   `AlertmanagerNotificationsFailing` is the alerting system's own smoke detector taken off the
   wall, and it will still be off the wall in three weeks.
4. Work through everything that fired during the blind window. Prometheus kept evaluating
   throughout, so the record is complete even though the delivery was not:

   ```bash
   curl -sS --get "$PROM/api/v1/query_range" \
     --data-urlencode 'query=ALERTS{alertstate="firing"}' \
     --data-urlencode "start=$BLIND_START" --data-urlencode "end=$(date -u +%s)" \
     --data-urlencode 'step=60' | jq -r '.data.result[].metric.alertname' | sort -u
   ```

## Verification

Delivery is not fixed because the counter stopped rising. It is fixed when something was
**delivered**, and there are three honest ways to establish that (this said "two" while listing three):

1. `pnpm run alerts:preflight -- --handshake` — proves the relay accepts this deployment's
   credentials right now. This is the credential half and only the credential half.
2. **`pnpm run alerts:ack`** — a real page through the real route tree, carrying a one-time code
   that is never printed on the passing path, and a bounded window in which a
   person has to type it back. Nothing else establishes the last hop: a relay that accepts the
   mail and a gateway that silently drops it are indistinguishable from this end. It is a command,
   but its pass condition is still a person with a phone, and it fails loudly when nobody answers.
3. **The heartbeat resumed at the watcher.** Two consecutive intervals with no alarm at whatever
   `PRL_ALERT_HEARTBEAT_WEBHOOK_URL` points at. One ping is what a heartbeat that has already
   failed looks like — see [`heartbeat-missing.md`](heartbeat-missing.md) § Verification.

Then confirm the counter has stopped moving *while notifications are being attempted* — a flat
counter with nothing to send proves nothing:

```bash
curl -sS "$PROM/api/v1/query?query=sum(increase(alertmanager_notifications_failed_total%5B15m%5D))"
curl -sS "$PROM/api/v1/query?query=sum(increase(alertmanager_notifications_total%5B15m%5D))"
```

The second must be non-zero for the first to mean anything.

## Escalation

- **Both integrations failed and the cause is not credentials or configuration** — this is an
  egress or DNS incident, and the deployment is probably failing in other ways too. Treat it as a
  platform incident.
- **A `page`-severity alert fired during the blind window** — that incident is the escalation.
  Open its runbook; this one is now the second priority.
- **This has happened before** — the fix is not in this runbook. It is a dead man's switch watched
  from outside the deployment, described in
  [The case these rules cannot report](#the-case-these-rules-cannot-report). The emitting half is
  shipped and verified; check that `PRL_ALERT_HEARTBEAT_WEBHOOK_URL` on this deployment points at a
  watcher that is armed, and that somebody's phone is attached to it.
- **The blind window cannot be bounded** — if the start of the failure cannot be established,
  record that in the incident notes as an unbounded window rather than guessing. An assumed
  start time is how an unrelated incident gets closed as "nothing happened".
