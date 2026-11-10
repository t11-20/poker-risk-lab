# WebSocket spike, storm, or refusal wave

Connection volume, churn, or refusals are far above this deployment's normal.

---

## Symptoms

- `prl_websocket_connections` far above the usual for the hour.
- Connections opening much faster than they close, or both rising together — a reconnect loop.
- Learners report the table reconnecting repeatedly, or "connecting…" that never resolves.
- Upgrades refused in volume.

## Detection

| Alert | Rule | Severity |
| --- | --- | --- |
| `WebSocketReconnectStorm` | `sum(rate(prl_websocket_opened_total[5m])) * 60 > max(prl_websocket_connections) + 5`, for 10 minutes | ticket |
| `WebSocketConnectionsHigh` | `prl_websocket_connections > 67` — 70% of the 96 at which one instance saturated in [`load-test.md`](../load-test.md) — for 10 minutes | ticket |
| `WebSocketRefusalSpike` | `sum(increase(prl_websocket_refused_total{reason="bad_origin"}[5m])) > 0`, for 10 minutes | ticket |

The reconnect-storm bar is **churn, not volume**: opens per minute against the number of sockets
actually standing. It is *not* a multiple of a close-rate baseline — that was the previous
expression, and [`alerts.md`](../alerts.md) records why it was replaced: `rate(opened[5m]) > 3 *
rate(closed[1h])` fired on any deployment busier by day than by night, and could not fire at all
before the first socket had ever closed. `for: 10m` is on all three rules; one stray refusal is
silent by design.

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_websocket_(connections|opened_total|closed_total|refused_total|frames_rejected_total)'
```

The **close code** is the diagnosis, and it is why `prl_websocket_closed_total` is labelled by it:

| Code | Meaning | Points at |
| --- | --- | --- |
| `4406` | origin not allowlisted | `PUBLIC_WEB_ORIGIN` wrong after a deploy, or a hostile client |
| `4401` | unauthenticated | session expiry wave, or cookies not reaching the socket |
| `4429` | too many sockets for one session | a client opening a socket per component, i.e. a client bug |
| `4503` | server shutting down | a deploy or a restart loop |
| normal close | the client went away | ordinary |

A storm with a **uniform** close code is a systematic cause. A storm with **mixed** codes is usually the network or the proxy.

## Immediate containment

**First: is it a restart loop wearing a storm's clothes?**

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_process_start_time_seconds
```

Every restart closes every socket with `serverShuttingDown` and every client reconnects at once. If the process is restarting, the storm is a symptom — go to [api-unhealthy.md](api-unhealthy.md) and stop reading here.

**If it is a genuine storm**, the danger is the feedback loop: reconnects cost CPU, CPU delays heartbeats, missed heartbeats drop more sockets, and those clients reconnect. The hub allows two missed pings before terminating, so a blocked event loop produces a storm on its own — check `prl_event_loop_delay_p99_seconds` and go to [worker-saturation.md](worker-saturation.md) if it is high. Breaking that loop takes priority over the socket count itself.

Shed load at the edge if you must. Do **not**:

- Widen `PUBLIC_WEB_ORIGIN` to stop `4406` refusals. The `Origin` check is the **only** server-side defence on a socket handshake — browsers send cookies on cross-origin WebSocket connections and CORS does not apply. If a legitimate origin is missing, add exactly that origin, having confirmed it.
- Raise the per-session socket limit to stop `4429`. That limit is what stops one tab from consuming a table's capacity.
- Restart to "clear" sockets. It drops every hand and guarantees a second storm.

## Diagnosis

### Refusal wave — `4406` (origin)

Almost always a deployment mistake, and it is worth checking the config before assuming an attack:

```bash
# What the server actually parsed. Origins are normalised and matched EXACTLY.
kubectl logs <pod> | grep '"msg":"listening"' | tail -1     # logs allowedOrigins
```

Exact match, never prefix or suffix. A trailing slash, a path, a wildcard, a trailing dot, or a scheme mismatch all match nothing — and `loadConfig` refuses several of those at boot precisely so they fail loudly rather than silently. A legitimate origin missing after a deploy is a configuration fix. A stream of refusals from origins you do not recognise is somebody trying, and the counter is the evidence.

### Refusal wave — `4401` (unauthenticated)

Either sessions expired en masse — check whether the API restarted with a *generated* development secret, which invalidates every session — or cookies are not reaching the socket. The latter is usually a proxy that drops `Cookie` on upgrade, or a `SameSite`/`Secure` mismatch after a scheme change.

### Reconnect storm with normal closes

The clients are being dropped and coming back. Causes, in order:

1. **Heartbeat failure from a blocked event loop.** Check `prl_event_loop_delay_p99_seconds` first.
2. **A proxy or load balancer idle timeout below the heartbeat interval.** The proxy silently closes an idle socket and the client reconnects, forever. This is the single most common cause of a storm in a new deployment and it is a proxy configuration fix — the upgrade timeout must exceed the heartbeat interval comfortably.
3. **A client-side reconnect loop with no backoff**, which turns one failure into a self-sustaining storm.

### Frames rejected

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_websocket_frames_rejected_total
```

Reasons come from a closed set. A wave of schema rejections is a client and server that disagree about the protocol — a half-completed deploy. A wave of oversized frames is either a bug or somebody probing. Either way the server is refusing correctly; the frame limits exist so a malformed or hostile frame cannot become the attack.

## Recovery

| Cause | Action |
| --- | --- |
| Restart loop | [api-unhealthy.md](api-unhealthy.md) — the storm ends when the loop does |
| Blocked event loop | [worker-saturation.md](worker-saturation.md) |
| Proxy idle timeout | raise it above the heartbeat interval; this belongs in the proxy config, permanently |
| Origin missing | add the exact origin to `PUBLIC_WEB_ORIGIN` and redeploy — never a wildcard, which matches nothing anyway |
| Session invalidation | ensure `SESSION_COOKIE_SECRET` is a real configured secret and stable across restarts |
| Client reconnect bug | fix the client's backoff; server-side, the per-session limit already bounds the damage |
| Genuine capacity | add instances. A table lives in one process, so this spreads tables, not one table |
| Hostile traffic | shed at the edge; the origin and auth checks are already refusing it correctly |

## Verification

```bash
# 1. Open and close rates are close again, and connections are stable rather than churning.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep -E 'prl_websocket_(connections|opened_total|closed_total)'
#    Sample twice a few minutes apart: opened and closed should increase by similar amounts.

# 2. Refusals have stopped, by reason.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_websocket_refused_total

# 3. The loop is quiet, so the feedback path is broken.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_event_loop_delay_p99_seconds

# 4. Hands are completing again — a storm mid-hand costs hands to turn-clock timeouts.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E 'prl_hands_(started|completed)_total'

# 5. A real socket journey, including reconnect.
pnpm run test:smoke --strict
```

If the fix was a proxy timeout, verify with a socket held open past the old timeout rather than by reading the configuration. The drill exists for this:

```bash
pnpm run test:drills --only ws-disconnect-mid-hand
```

## Escalation

Escalate when:

- The storm persists with a quiet event loop, a stable process and a correct proxy configuration. Something is driving it that none of the three explain.
- `4406` refusals come from origins nobody recognises, sustained. That is a probe, and it belongs with the security owner.
- Connection volume routinely exceeds the measured ceiling in [`../load-test.md`](../load-test.md). That is a sizing decision, not an incident.
- Hands are being lost to turn-clock timeouts during the storm. It has stopped being an availability problem and become a correctness one.
