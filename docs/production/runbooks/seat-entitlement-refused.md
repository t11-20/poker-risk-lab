# Learners are being refused seats

The seat guard is turning people away for want of a live enrolment — or a chair somebody held was not given back after a restart, for the same reason and with nobody at a keyboard to notice.

Read [README.md](README.md) first.

**Neither alert in this file can move on a deployment where `PRL_ENROLMENT_REQUIRED` is unset or `off`**, which is the shipped default. If one of them fires, this deployment is `enforced` and there is a cohort behind it. That single fact decides most of the diagnosis below.

---

## Symptoms

- A learner — usually several at once, usually at the start of a lesson — is refused a seat and told to ask whoever enrols their class. Lessons, the Lab and the glossary keep working for them: the guard is on **taking a seat** and nothing else.
- A chair that was occupied before a restart is empty afterwards, and its holder cannot retake it.
- Nothing else is wrong. No request fails with a 5xx, latency is flat, hands complete.

## Detection

| Alert | Rule | Severity |
| --- | --- | --- |
| `SeatEntitlementRefused` | `sum(increase(prl_seat_entitlement_refusals_total{reason="not_entitled"}[10m])) > 5` | ticket |
| `SeatNotRestored` | `sum(increase(prl_seat_entitlement_refusals_total{reason="seat_not_restored"}[15m])) > 0` | ticket |

The `reason` label is a closed set of two, and summing them is a mistake — they are different operator questions:

| `reason` | Who is affected | What it means |
| --- | --- | --- |
| `not_entitled` | somebody at a keyboard, right now | they asked for a seat and were told no. Six in ten minutes is a **group**, not a passer-by, and the usual cause is a class list that missed people |
| `seat_not_restored` | nobody, at the moment it happens | a room re-opened after a restart did not give back a chair recorded in `room_members`, because its holder's enrolment has since expired or been revoked. The chair is then freed so the table is usable |

`seat_not_restored` is **the only refusal in this system that can move with nobody using the product**, which is exactly why it has a rule: no request fails, no learner is present, and the chair is simply gone the next time they look.

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_seat_entitlement_refusals_total
```

Both series are primed at zero from boot, so the **first** refusal is a rise from zero rather than a series appearing — which matters here more than almost anywhere else, because the first refusal is the one an operator most wants (a class list that missed somebody, on the morning of the class).

Two things this is **not**:

- **Not** `prl_api_errors_total{code="enrolment_required"}`. That counts REST responses, so it misses every socket refusal — a `sit` frame is answered with an error *frame* and no HTTP status — and misses `seat_not_restored` entirely, which no request ever sees.
- **Not** a database problem. A database that cannot answer "is this person entitled" does not produce this counter: the error propagates, becomes `internal_error`, and closes the socket 4503 (the *retryable* branch). Fail closed on the seat, and honest about which direction the failure was in. So if you are here, the database answered — the answer was "no".

## Immediate containment

**There is nothing to contain, and one thing not to do.**

Do **not** set `PRL_ENROLMENT_REQUIRED=off` to clear this. It is not a limit and not a safety valve — it is the policy switch that decides whether a seat needs an enrolment at all, and turning it off opens every table to anybody with a session, including a stranger who guessed a room id. Whether a cohort's tables are open is a decision owned by whoever enrols the cohort, not by the on-call, and it is a much larger decision than the ticket in front of you. The fix for "the right people cannot sit" is to enrol the right people, and that is one command.

Do **not** try to fix it through the API. The request-path role (`prl_app`) holds **SELECT only** on both enrolment tables, by design and at the database level: the API can ask who is entitled and cannot enrol, extend or un-revoke anybody. Grants need `DATABASE_MIGRATION_URL` and the operator CLI. There is deliberately no HTTP admin API, and this is not the week to add one.

If a class is starting *right now* and cannot sit, go straight to §Recovery — a grant takes effect on the next attempt, with no restart.

## Diagnosis

### 1. Which learner, which room, which seat — from the log

The counter carries no identifier, on purpose. Which learner, which room and which seat are in the log line beside it:

```bash
kubectl logs <pod> --since=1h | grep 'no live enrolment entitles this account'
```

That line names the room and the seat. What it deliberately does **not** name is *why* the person is not entitled: revoked, expired, not started yet and "enrolled in a cohort that has ended" are all the same boolean to the seat guard, because "your place was withdrawn" and "your place has not started yet" are facts about a person that a table refusal is the wrong place to disclose.

### 2. Why, per learner — from the operator tool

```bash
pnpm run enrolments show --user usr_...
pnpm run enrolments list --cohort <key> --all
pnpm run enrolments cohorts
```

`show` is the tool that answers the question the refusal would not. The usual four answers, and what each one means:

| What `show` says | Almost always |
| --- | --- |
| no enrolment at all | the class list missed them — the common case behind `SeatEntitlementRefused` |
| revoked | somebody revoked it. Check `--reason` and who did it before restoring anything |
| expired | `--expires` was set to the cohort's end and the cohort has ended, or was set short by mistake |
| not started | the cohort's `--starts` is in the future. A cohort that begins at 09:00 refuses at 08:55, and this is the one that produces a burst of refusals at a predictable minute |

### 3. Is it one person or a class?

```bash
# Distinct learners in the window, from the log rather than the metric.
kubectl logs <pod> --since=1h | grep -c 'no live enrolment entitles this account'
```

A handful of refusals from one account is somebody whose place ended. A burst from many accounts inside a few minutes, at the top of an hour, is a cohort — a list that was imported short, a start date a day late, or an end date that arrived while the course was still running.

### 4. `seat_not_restored` specifically: was there a restart, and did an enrolment change?

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_process_start_time_seconds
pnpm run enrolments show --user usr_...      # the holder of the chair, from the log line
```

This alert **should** follow a restart, and a revocation or expiry taking effect at the next restart rather than at the moment of the write is a legitimate outcome — that is the design, and it is why this is a ticket. What is not legitimate is this firing when nobody's enrolment changed: then a chair was lost to a bug rather than to a policy, and that goes to §Escalation.

## Recovery

| Cause | Action |
| --- | --- |
| Class list missed people | `pnpm run enrolments grant --cohort <key> --by "<person>" --reference <ref> --expires <date> --file class.txt`. Takes effect on the next attempt; no restart, no deploy |
| Cohort starts later than the lesson | fix the cohort's `--starts`. Check the timezone before assuming the date is wrong |
| Enrolment expired mid-course | extend it, with a reference. An expiry that keeps needing extension is a course whose end date is wrong |
| Deliberate revocation | nothing to fix. Record that the refusal was correct and close the ticket — this alert firing for a revoked place is the system working |
| `seat_not_restored` after a revocation | nothing to fix. The chair was freed on purpose and the table is usable |
| `seat_not_restored` with no enrolment change | do not re-grant to make it go away. Escalate; the seat was lost to a bug |
| Enrolment is not required on this deployment at all | then `PRL_ENROLMENT_REQUIRED` is `enforced` when it should not be. That is a configuration decision, made deliberately, not a switch flipped during a ticket |

Every grant records **who holds a place and on whose authority** — never an amount. A scholarship cohort and a paid one produce identical rows, so `--by` and `--reference` are the whole audit trail. Fill them in properly; "restored during incident" with no reference is how a place nobody can account for gets created.

## Verification

```bash
# 1. The refusals have stopped. Sample twice, ten minutes apart — a counter that
#    stopped and one still rising slowly look identical in one sample.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep prl_seat_entitlement_refusals_total

# 2. The people who were refused are now entitled, per learner.
pnpm run enrolments show --user usr_...

# 3. The cohort holds the number of places it should.
pnpm run enrolments list --cohort <key>

# 4. Somebody can actually sit. The smoke run takes a seat end to end over TLS.
pnpm run test:smoke --strict
```

Step 4 matters more than it looks: a grant that satisfies `enrolments show` and still does not produce a seat means the guard is refusing for a different reason than the one you fixed, and the guard is a single choke point in `rooms/registry.ts` covering all three ways to reach a seat (REST, the WebSocket `sit` frame, a Legends match).

## Escalation

Escalate when:

- `SeatNotRestored` fired and **no enrolment expired or was revoked**. A chair was taken away by something other than policy, and the seat is gone from the durable row as well as from the table.
- Refusals continue for accounts that `enrolments show` reports as entitled. The guard and the enrolment store disagree, which is a correctness fault in the one control that decides who may sit.
- Somebody proposes turning `PRL_ENROLMENT_REQUIRED` off, or widening `prl_app`'s grants on the enrolment tables, to clear the incident. Both need a second person and neither is an on-call decision.
- A whole cohort is locked out with a lesson in progress and the enrolling person cannot be reached. That is a commercial and teaching problem before it is an operations one — say so early, and say what a grant would need.

Attach to the escalation: the counter samples by `reason`, the log lines (room and seat, not learner ids in a chat), the output of `enrolments show` for one affected account, the cohort's start and end dates, and the process start time.
