# The retention sweep has stopped running

Nothing is broken. Every request succeeds, every table reads, every hand deals. What has stopped is
the four-times-a-day job that removes expired sessions, expired sign-in attempts and abandoned guest
accounts — so rows this deployment tells its readers are deleted on a schedule are not being
deleted, and will keep not being deleted until somebody does something.

Treat this as the data-protection incident it is rather than as a stuck cron job. The privacy page
makes a statement of fact to every reader (`/privacy` §5: *"The code that removes expired sessions
and expired sign-in attempts runs on a schedule — every six hours, inside the server, in bounded
batches"*). While this alert is firing that statement is false.

---

## Symptoms

- `prl_retention_sweep_age_seconds` is above 27,000 and climbing. It only ever climbs.
- No log line reading `retention sweep` in the last six hours. It is emitted at `info` on every
  completed sweep, with `sweptSessions`, `sweptLoginAttempts` and `sweptGuestAccounts`.
- Everything else is green. That is expected, and it is the reason this alert exists.

## Detection

| Alert | Rule |
| --- | --- |
| `RetentionSweepStalled` | `max(prl_retention_sweep_age_seconds) > 27000` for 15m |

**Why the counter beside it cannot detect this.** `prl_retention_rows_deleted_total{kind}` staying
flat is the normal state of a healthy small deployment: most six-hour windows genuinely have nothing
to remove. "Removed nothing" and "did not run" are the same flat line, so the sweep exports its own
age and the rule reads that. The age starts from process start rather than from zero, so a freshly
restarted process is not instantly stale — the first sweep is at T+60s, not at boot.

**The number used to be T+6h, and that made this rule unable to fire on the worst case.** Because
the age substitutes process uptime until this process has swept, it is reset by every restart: a
deployment redeployed more often than the six-hour interval never reached its first sweep, swept
nothing for its entire life, and drew a sawtooth peaking at 21,600 s against a 27,000 s threshold.
Reproduced in `apps/api/test/retention-sweep.test.ts` — eight consecutive five-hour deployments,
zero sweeps. The first sweep is now sixty seconds after start, which also makes the fallback
argument ("a process restarting often enough to hide a dead timer is already `ProcessRestartLoop`")
true rather than merely stated: three processes that die before sweeping fit inside that rule's
fifteen-minute window. What the gauge still cannot see is whether the PREVIOUS process swept.

## Immediate containment

**There is nothing to contain, and that is a real answer rather than an omission.** Nothing is
leaking, nobody is being served wrong data, and no learner is affected. The cost of this incident is
rows that should have gone still being present, and it accrues slowly. Do not restart the API to
"fix" it before reading the next section: a restart drops every hand in progress
(`README.md` in this directory, "the one architectural fact"), and doing that to a live table to
tidy up a maintenance timer is a worse trade than waiting for the next scheduled sweep.

## Diagnosis

Work down this list. Each step distinguishes one cause from the rest.

```bash
# 1. How stale, and since when? The age in seconds, and when the process started.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep -E 'prl_retention_sweep_age_seconds|prl_process_start_time_seconds'

# 2. Has it ever swept in this process? Compare the age against the uptime: an age that
#    EQUALS the uptime means no sweep has ever completed since boot.

# 3. What did the last attempt say? Both of these are logged and neither is fatal.
#    "retention sweep failed"                        -> the sweep threw; see 4.
#    "retention sweep could not erase a guest account" -> one account is stuck; see 5.
docker compose logs api --since 24h | grep -E 'retention sweep'

# 4. Is the database answering at all? A sweep failing every tick is usually not about
#    the sweep.
curl -sS -o /dev/null -w 'ready %{http_code}\n' "$API/api/v1/ready"

# 5. How much backlog is waiting? Read-only, and it is the honest measure of the incident.
psql "$DATABASE_URL" -c "
  select (select count(*) from prl.sessions where expires_at <= now()) as expired_sessions,
         (select count(*) from prl.oidc_login_attempts where expires_at <= now()) as expired_attempts,
         (select count(*) from prl.users
           where kind = 'guest' and last_seen_at <= now() - interval '60 days') as old_guests;"
```

### The four causes, in the order they actually happen

**a. The database was unavailable and the sweep has been failing every tick.** The log says
`retention sweep failed` four times a day. This is by design — a maintenance timer that can take the
process down is worse than no maintenance timer — but it means the age gauge is doing exactly its
job. Fix the database; the next tick catches up on its own, in bounded batches.

**b. The process is wedged rather than dead.** `/ready` answers, scrapes succeed, but no timer has
fired. The sweep is a `setInterval` inside the API process, so anything that has stopped the event
loop stops it. Check `prl_event_loop_delay_p99_seconds`; if that is also bad, this alert is a
symptom and `EventLoopBlocked` is the incident.

**c. The sweep was never started.** The age exactly equals the process uptime and there has never
been a `retention sweep` line in this process's life. `startRetentionSweep` is called after
`app.listen` in `apps/api/src/server.ts`, so a build that reached listening without reaching that
call is a code or startup-ordering defect. This is the failure this whole subsystem exists because
of: the sweeps were implemented, tested, and called by nothing at all
(`docs/production/legal-review-requirements.md` §7).

**d. One guest account is stuck and everything else is fine.** This does NOT cause this alert — the
sweep still completes and the age still resets — but you will meet it in the same logs. The line is
`retention sweep could not erase a guest account` with a `userId`, and `sweepGuestsBlocked` in the
completion line is non-zero. It means `prl.users` has acquired a foreign key with no referential
action, which `db/migrations/0004_account_deletion.sql` warns about in as many words. It is a schema
defect, it needs a migration, and it is not urgent: everything else in the batch still goes.

## Recovery

For (a) and (b): fix the underlying problem. The sweep needs nothing else — the next tick works
through the backlog in batches of 1,000, up to 100 passes per kind per sweep, and reports
`sweepIncomplete: true` if there is still more to take. A backlog of any realistic size drains in a
few sweeps rather than in one.

For (c): this is a deploy, not an operation. Roll back to the previous image
([`rollback.md`](rollback.md)) if the previous one swept, and raise the defect.

**Restarting the API is a legitimate last resort and is not free.** It clears (b), it does nothing
for (a) or (c), and it drops every hand in progress. If you do it, do it when tables are quiet, and
note that the age gauge reads healthy immediately even though nothing has been swept yet — it
substitutes uptime until this process has completed a sweep. The first sweep of the new process is
sixty seconds later, so the verification below is a minute's wait rather than six hours', and it
matters more than usual: the gauge cannot tell you the previous process was failing.

## Verification

```bash
# 1. A sweep has completed. This is the only thing that resets the age.
docker compose logs api --since 30m | grep 'retention sweep'

# 2. The gauge has fallen back to roughly zero, and the counters have moved if there
#    was anything to take.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep -E 'prl_retention_sweep_age_seconds|prl_retention_rows_deleted_total'

# 3. The backlog query from step 5 above returns smaller numbers than it did.
```

Do not close this on the gauge alone after a restart: it reads healthy from the moment the process
starts. Close it on a `retention sweep` log line, which only a completed sweep produces.

## Escalation

- **Still firing tomorrow.** It stops being a working-hours ticket at that point: a full day with no
  sweep is a retention promise broken long enough to be worth telling whoever owns the privacy
  statement about.
- **`sweepGuestsBlocked` is persistently non-zero.** Raise it as a schema defect against
  `db/migrations/`; a new reference to `prl.users` without a referential action also breaks
  `POST /me/delete` for the same accounts, which is a learner-visible failure with its own runbook
  ([`account-deletion-failure.md`](account-deletion-failure.md)).
- **The backlog is millions of rows.** The bounded sweep will still finish, but check autovacuum
  before assuming the tables are healthy; a table that has grown for months does not shrink just
  because the rows are gone.
