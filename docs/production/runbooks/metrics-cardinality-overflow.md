# A metric has folded into its overflow series

The cardinality cap engaged. Some metric stopped being precise, and everything built on it — a rule, a dashboard, a number in a postmortem — is now reading a partial answer while looking exactly as it did before.

Read [README.md](README.md) first. This is a **ticket**, and the reason is worth stating: nothing is broken for a learner, nothing is at risk, and the product is fine. What is broken is the instrument, and the failure is invisible in every direction except this one alert. Do not restart the API to "clear" it — §Immediate containment says why that is the one destructive move available here.

---

## Symptoms

- No learner symptom at all. This alert is the entire symptom.
- A series in a dashboard or a query that plateaus and stops moving while the thing it measures obviously keeps happening.
- A label value of `overflow_cardinality_capped` appearing in the exposition.

## Detection

| Alert | Rule | Severity |
| --- | --- | --- |
| `MetricsCardinalityOverflow` | `prl_metrics_cardinality_overflow == 1` | ticket |

The gauge is 1 once **any** metric in the process has folded at least one label combination into its overflow series (`anyOverflowed()` in `observability/registry.ts`). It is a per-process latch: it never returns to 0 for the life of the process, because precision that was lost is not regained by the traffic stopping.

Two facts about the mechanism decide everything below:

- **The cap is a net, not the design.** Every label in this system is meant to come from a closed set — `routeLabel()` returns the Fastify route *pattern* and `unmatched` for anything that matched no route, `methodLabel()` narrows to seven verbs, `errorCodeLabel()` narrows to declared contract codes. The cap (`MAX_SERIES_PER_METRIC = 256`) exists under those, for the case where somebody adds a label from an open set. If it engaged, either a caller is passing an unbounded value into a label, or a code change introduced a label that is not a closed set.
- **The overflow value is deliberately greppable.** Past the cap, every new combination collapses into a single series whose every label is `overflow_cardinality_capped`. That is what makes the next section a grep rather than an investigation.

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -E \
  'prl_metrics_cardinality_overflow|prl_metrics_series'
```

`prl_metrics_series` is the total live series across every metric. A plateau in it, at a multiple of 256, is the same story told as a number.

## Immediate containment

**There is nothing to contain, and one thing not to do: do not restart the API.**

A restart clears the latch and empties every series map, so the alert stops and the exposition looks healthy again. It also destroys the only copy of the evidence — the overflowed metric, its live series and the label values that filled it are in that process's memory and nowhere else — and if a caller is still sending the unbounded value, the cap re-engages and the alert returns having cost a set of hands in progress (see README, "live table state is in-process").

Capture first, always:

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" > /tmp/overflow-$(date +%s).prom
```

That file is the whole investigation. Treat it as sensitive: it is this deployment's full exposition, read with the metrics bearer token.

## Diagnosis

### 1. Which metric overflowed?

```bash
grep 'overflow_cardinality_capped' /tmp/overflow-*.prom
```

Every line that matches names the metric family on the left of the `{`. There is usually exactly one.

### 2. Which label is unbounded?

Count distinct values per label on the affected family, from the same capture:

```bash
# Replace prl_http_requests_total with the family from step 1.
grep '^prl_http_requests_total{' /tmp/overflow-*.prom \
  | sed 's/.*{//; s/}.*//' | tr ',' '\n' | sort | uniq -c | sort -rn | head -30
```

The label with hundreds of values is the fault. Then the two cases:

| What you see | What it is |
| --- | --- |
| A label whose values are ids, paths, user agents, or free text | a code change put an open set into a label. That is the defect; the cap did its job |
| `route="unmatched"` present but bounded, and some *other* label unbounded | as above — `unmatched` is the guard for scanners and is working |
| Values that look like a closed set but there are more of them than you expected | the set grew legitimately (routes added, error codes added) and the cap is now too tight for a real design |

### 3. Is it a caller or a deploy?

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_process_start_time_seconds
```

Correlate the onset with the process start. Overflow that appears minutes after a deploy is the deploy. Overflow on a process that has been up for days, with values that look like input, is a caller — and a caller minting series is worth a look at [automated-abuse.md](automated-abuse.md), because it is the same population as a scanner walking a wordlist.

### 4. What else was reading that metric?

This is the step people skip, and it is the reason the alert exists. Ask what depends on the metric that lost precision:

```bash
grep -n '<the metric family>' deploy/staging/observability/alert-rules.yml docs/production/alerts.md
```

**Any alert rule keyed on the affected family has been reading a partial answer for as long as the overflow has been latched.** A rule that sums the family is roughly fine — the overflow series still counts. A rule that selects by label (`{status="5xx"}`, `{kind="banned"}`) is not: the folded samples carry `overflow_cardinality_capped` in every label, so they match no selector, and the rule has been silently *under*-counting. Say so in the ticket, and treat any conclusion drawn from that rule during the window as unsupported.

## Recovery

| Cause | Action |
| --- | --- |
| A label from an open set, added by a code change | fix the label at the call site — narrow it to a closed set the way `routeLabel`, `methodLabel` and `errorCodeLabel` do, or remove it. This is the fix; the cap is not |
| A caller passing unbounded values into a label that should have been closed | the same fix. A caller must not be able to choose a label value — that is the invariant, and the cap only bounds the damage |
| A closed set that genuinely outgrew 256 | raise `MAX_SERIES_PER_METRIC` in `observability/registry.ts` **with the arithmetic written down**, the way its header already does it (declared routes × status classes). A cap raised without a product to justify it is a cap that will be raised again |
| A metric nobody needs at that granularity | drop the label. Per-entity investigation belongs in the logs, correlated by request id, where access and retention are governed |

Deploying the fix restarts the process, which is what clears the latch — as a consequence of the fix, not as the fix. If the affected metric is genuinely load-bearing for an incident happening *right now* and the label fault is understood, a restart to restore precision is defensible, once the capture in §Immediate containment exists.

## Verification

```bash
# 1. The latch is 0 on the new process, and stays 0.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_metrics_cardinality_overflow
#    Take it again an hour later, and again after a day. A latch that clears at a
#    deploy and re-engages on the same traffic means the fix was the restart.

# 2. No overflow series anywhere in the exposition.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -c overflow_cardinality_capped
#    Expect 0.

# 3. Total live series is far below the cap and stable.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_metrics_series

# 4. The label that overflowed now has the number of values its closed set has.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep '^<the metric family>{' | sed 's/.*{//; s/}.*//' | tr ',' '\n' | sort -u | wc -l
```

The unit test that pushes a metric past its cap (`alerts.md` § Verifying these rules lists it as this alert's provocation) is what proves the mechanism still works; the four checks above prove this deployment is no longer using it.

## Escalation

Escalate when:

- The unbounded values are **caller-supplied strings**. A caller who can mint series can grow this process's memory from outside, and the cap is the only thing between that and the host. That is a security finding, not a telemetry one.
- The overflowed family is one an alert rule selects by label. Somebody has to decide what to do about the window in which that rule was under-counting, and that decision is not the on-call's alone.
- The cap needs raising and nobody can produce the arithmetic for the new number.
